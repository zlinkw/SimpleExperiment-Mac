import ast
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile

root = pathlib.Path(tempfile.mkdtemp(prefix="simpleex-plan-source-"))
source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
embedded = source.split("String.raw`", 1)[1].rsplit("`;", 1)[0]
scope = dict(os=os, pathlib=pathlib, re=re, hashlib=hashlib, json=json, now_iso=lambda: "now")
def check(base, relative, expected, verify_content=False):
    data = (pathlib.Path(base)/relative).read_bytes()
    if len(data) != expected["size"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        raise ValueError("mounted code changed: " + relative)
    return {"path": relative, **expected}
scope["_code_sync_stat_record"] = check
exec(compile(embedded, "PlanCodeScope", "exec"), scope)
def write(relative, text):
    target = root/relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
def sha(relative):
    return hashlib.sha256((root/relative).read_bytes()).hexdigest()
write("plans/a.yaml", "base_config: configs/a.yaml\nrunner:\n  command: python -m adapter.run -- python train.py\nnaming:\n  output: work_dirs/a\nexpectedResults:\n  - current_metrics.json\n")
write("configs/a.yaml", "defaults_from: configs/base.yaml\nmethod: one\n")
write("configs/base.yaml", "batch: 4\n")
write("adapter/__init__.py", "")
write("adapter/run.py", "from utils.core import run\n")
write("utils/__init__.py", "")
write("utils/core.py", "def run(): return 1\n")
write("train.py", "from adapter import run\nimport importlib\nmodule_name = f'plugins.{name}.adapter'\nimportlib.import_module(module_name)\n")
write("plugins/__init__.py", "")
write("plugins/one/__init__.py", "")
write("plugins/one/adapter.py", "from . import helper\n")
write("plugins/one/helper.py", "from pathlib import Path\nimport importlib.util\n_SOURCE = Path(__file__).resolve().parents[2] / 'vendor' / 'impl.py'\nimportlib.util.spec_from_file_location('vendor_plugin', _SOURCE)\nVALUE = 1\n")
write("vendor/impl.py", "VALUE=1\n")
write("plugins/two/adapter.py", "VALUE = 2\n")
write("plans/b.yaml", "base_config: configs/b.yaml\n")
write("configs/b.yaml", "batch: 999\n")
write("work_dirs/a/job_config.yaml", "generated: 1\n")
write("experiments/results/old.csv", "metric\n1\n")
write("utils/__pycache__/core.pyc", "cache")
revision = sha("plans/a.yaml")
row = dict(projectId="project", planFile="plans/a.yaml", planRevision=revision, codeFingerprint="original")
paths, conservative = scope["plan_source_scope"](str(root), row["planFile"], revision)
assert set(paths) == {"plans/a.yaml", "configs/a.yaml", "configs/base.yaml", "adapter/__init__.py", "adapter/run.py", "utils/__init__.py", "utils/core.py", "train.py", "plugins/__init__.py", "plugins/one/__init__.py", "plugins/one/adapter.py", "plugins/one/helper.py", "vendor/impl.py"}, paths
manifest = {p: dict(size=(root/p).stat().st_size, sha256=sha(p)) for p in paths}
baseline = dict(manifest=manifest, digest=scope["plan_source_digest"](manifest))
scope["verify_plan_execution_source"](str(root), row, baseline)
write("current_metrics.json", "{\"metric\": 1}\n")
full_manifest = dict(manifest)
for file in ("work_dirs/a/job_config.yaml", "experiments/results/old.csv", "utils/__pycache__/core.pyc", "plans/b.yaml", "configs/b.yaml", "plugins/two/adapter.py"):
    full_manifest[file] = dict(size=(root/file).stat().st_size, sha256=sha(file))
row["codeFingerprint"] = scope["plan_source_digest"](full_manifest)
proof = dict(projectId="project", codeFingerprint=row["codeFingerprint"], files=[dict(path=k, **v) for k,v in full_manifest.items()])
scope["code_sync_proof_document"] = lambda _: {"proofs": {"original": proof}}
scope["durable_code_manifest_digest"] = scope["plan_source_digest"]
for file in ("work_dirs/a/job_config.yaml", "experiments/results/old.csv", "utils/__pycache__/core.pyc", "plans/b.yaml", "configs/b.yaml", "plugins/two/adapter.py"):
    write(file, "changed unrelated\n")
scope["verify_plan_execution_source"](str(root), row, baseline)
report = scope["inspect_plan_code_scope"](str(root), row)
assert report["executionSource"] == baseline and report["compatible"] is True and report["readOnly"] is True
agent = pathlib.Path(sys.argv[1]).parent.parent.joinpath("clusterAgentRuntime.legacy.ts").read_text(encoding="utf-8")
def function(text, name):
    match = re.search(r"(?m)^def " + name + r"\([^\n]*\):\n[\s\S]*?(?=\n(?:def |class |[A-Z][A-Z_]+\s*=)|\Z)", text)
    assert match, name
    return match.group(0)
exec(compile(function(agent, "resolve_durable_code_sync_proof"), "source-admission", "exec"), scope)
assert scope["resolve_durable_code_sync_proof"](str(root), dict(row, executionSource=baseline))["fileCount"] == len(paths)
native = pathlib.Path(sys.argv[1]).parent.joinpath("TmuxTaskLifecycle.ts").read_text(encoding="utf-8")
scope.update(task_safe_path=scope["plan_scope_path"], task_inventory=lambda _: [])
exec(compile(function(native, "task_queue_job"), "native-source-admission", "exec"), scope)
command = dict(row, commandId="synthetic", workflowId="w", globalJobId="w:0", experimentIndex=0, workerId="worker", outputDir="work_dirs/a", collectionResultCsv="tmp/a.csv", resultPathPolicy="declared", executionSource=baseline)
assert scope["task_queue_job"](str(root), "worker", command)["executionSource"] == baseline
for file in ("configs/base.yaml", "utils/core.py", "plugins/one/helper.py"):
    original = (root/file).read_text(encoding="utf-8")
    write(file, original + "\n# real source change\n")
    try:
        scope["verify_plan_execution_source"](str(root), row, baseline)
        raise AssertionError("changed source accepted: " + file)
    except ValueError as exc:
        assert file in str(exc), str(exc)
    write(file, original)
write("utils/new.py", "VALUE=1\n")
write("utils/core.py", "from .new import VALUE\n")
try:
    scope["verify_plan_execution_source"](str(root), row, baseline)
    raise AssertionError("new dependency accepted")
except ValueError as exc:
    assert "DEPENDENCIES_CHANGED" in str(exc)
write("utils/core.py", "def run(): return 1\n")
try:
    scope["verify_plan_execution_source"](str(root), row, dict(baseline, digest="0"*64))
    raise AssertionError("bad digest accepted")
except ValueError:
    pass
try:
    scope["plan_scope_path"](str(root), "../outside.py")
    raise AssertionError("escape accepted")
except ValueError:
    pass
print(json.dumps(dict(ok=True, files=len(paths), generatedChangesIgnored=6, sourceChangesRejected=3)))
