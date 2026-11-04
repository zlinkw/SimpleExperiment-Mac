import ast
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
import shutil

root = pathlib.Path(tempfile.mkdtemp(prefix="simpleex-plan-source-"))
source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
if "String.raw`" in source:
    embedded = source.split("String.raw`", 1)[1].rsplit("`;", 1)[0]
    agent = pathlib.Path(sys.argv[1]).parent.parent.joinpath("clusterAgentRuntime.legacy.ts").read_text(encoding="utf-8")
else:
    agent = source
    definitions = ast.parse(source)
    selected = [node for node in definitions.body if isinstance(node, ast.FunctionDef) and
                (node.name.startswith(("plan_scope_", "plan_source_")) or node.name in ("verify_plan_execution_source", "inspect_plan_code_scope"))]
    embedded = ast.unparse(ast.Module(body=selected, type_ignores=[]))
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
def function(text, name):
    match = re.search(r"(?m)^def " + name + r"\([^\n]*\):\n[\s\S]*?(?=\n(?:def |class |[A-Z][A-Z_]+\s*=)|\Z)", text)
    assert match, name
    return match.group(0)
exec(compile(function(agent, "resolve_durable_code_sync_proof"), "source-admission", "exec"), scope)
assert scope["resolve_durable_code_sync_proof"](str(root), dict(row, executionSource=baseline))["fileCount"] == len(paths)
native = pathlib.Path(sys.argv[1]).parent.joinpath("TmuxTaskLifecycle.ts").read_text(encoding="utf-8") if "String.raw`" in source else source
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
# Reproduce the reported multi-method metadata chain without importing any project code.
original_root = root
root = original_root / "multi-method"
root.mkdir()
plan = "experiments/plans/comparison/cross_encoder_completion_bus_cot_lesion_P0_v1.yaml"
history = "experiments/results/simmlm_original_final_20261026/results.json"
write(plan, "runner:\n  command: python train.py --config configs/train.json\n")
write("train.py", "from experiments.cli_config import build\nfrom models.core import train\nimport json\nfrom pathlib import Path\nDATA = Path('inputs/current.json')\njson.loads(DATA.read_text())\n")
write("experiments/cli_config.py", "from comparison_methods.osiris.study import study\n")
write("models/core.py", "def train(): raise RuntimeError('must never execute')\n")
write("comparison_methods/osiris/study.py", "from pathlib import Path\nfrom .final_history import actual_digest as frozen_digest\nROOT = Path(__file__).resolve().parents[2]\ndef verify_definitions():\n    if maintenance_needed:\n        frozen_digest(ROOT / 'comparison_methods/osiris_ovr/design.json')\ndef study(): pass\n")
write("comparison_methods/osiris/final_history.py", "import hashlib\nfrom pathlib import Path\ndef actual_digest(path):\n    return hashlib.sha256(Path(path).read_bytes()).hexdigest()\n")
write("experiments/active_registry.py", "from comparison_methods.simmlm.publication import published\n")
write("comparison_methods/osiris_ovr/design.json", json.dumps({"definitions_sha256": {"experiments/active_registry.py": sha("experiments/active_registry.py")}}))
write("comparison_methods/simmlm/publication.py", "PUBLISHED = 'comparison_methods/simmlm/published_original.json'\ndef published(): pass\n")
write("comparison_methods/simmlm/published_original.json", json.dumps({"record": history}))
write(history, " " * 2365305)
write("configs/train.json", json.dumps({"base_config": "configs/base.yaml", "metadata": {"record": history}}))
write("configs/base.yaml", "batch: 4\n")
write("inputs/current.json", json.dumps({"rows": [1, 2], "record": history}))
before_history = sha(history)
resource_paths, _ = scope["plan_source_scope"](str(root), plan, sha(plan))
expected = {plan, "train.py", "experiments/cli_config.py", "models/core.py", "comparison_methods/osiris/study.py", "comparison_methods/osiris/final_history.py", "comparison_methods/osiris_ovr/design.json", "configs/train.json", "configs/base.yaml", "inputs/current.json"}
assert set(resource_paths) == expected, resource_paths
assert history not in resource_paths and sha(history) == before_history
assert (root / history).stat().st_size == 2365305

# Verify the actual Agent file/hash validator too, not a substitute validator.
exec(compile(function(agent, "_code_sync_stat_record"), "source-file-validator", "exec"), scope)
resource_manifest = {p: dict(size=(root/p).stat().st_size, sha256=sha(p)) for p in resource_paths}
resource_row = dict(projectId="resource-project", planFile=plan, planRevision=sha(plan), codeFingerprint="original")
resource_source = dict(manifest=resource_manifest, digest=scope["plan_source_digest"](resource_manifest))
scope["verify_plan_execution_source"](str(root), resource_row, resource_source)
assert scope["task_queue_job"](str(root), "worker", dict(command, **resource_row, executionSource=resource_source))["executionSource"] == resource_source
for changed in ("models/core.py", "configs/base.yaml", "inputs/current.json", "comparison_methods/osiris_ovr/design.json"):
    original = (root/changed).read_text(encoding="utf-8")
    write(changed, original + " ")
    try:
        scope["verify_plan_execution_source"](str(root), resource_row, resource_source)
        raise AssertionError("real dependency change accepted: " + changed)
    except ValueError as exc:
        assert changed in str(exc), str(exc)
    write(changed, original)

missing_root = original_root / "missing-source"
shutil.copytree(root, missing_root, ignore=lambda directory, names: ["core.py"] if pathlib.Path(directory) == root / "models" else [])
try:
    scope["verify_plan_execution_source"](str(missing_root), resource_row, resource_source)
    raise AssertionError("missing imported source accepted")
except ValueError as exc:
    assert "models/core.py" in str(exc) and "dependency chain" in str(exc), str(exc)

# A consumed path -> digest map adds byte-only integrity dependencies, not code imports.
original_train = (root/"train.py").read_text(encoding="utf-8")
write("train.py", original_train + "\njson.loads(Path('comparison_methods/osiris_ovr/design.json').read_text())\n")
unconsumed_paths, _ = scope["plan_source_scope"](str(root), plan, sha(plan))
assert "experiments/active_registry.py" not in unconsumed_paths, "reading a document is not consuming its digest map"
write("train.py", original_train + "\nfrom comparison_methods.osiris.final_history import actual_digest\ndefinitions = json.loads(Path('comparison_methods/osiris_ovr/design.json').read_text())\nfor file, expected in definitions['definitions_sha256'].items():\n    actual_digest(file)\n")
integrity_paths, _ = scope["plan_source_scope"](str(root), plan, sha(plan))
assert "experiments/active_registry.py" in integrity_paths
assert "comparison_methods/simmlm/publication.py" not in integrity_paths and history not in integrity_paths
integrity_manifest = {p: dict(size=(root/p).stat().st_size, sha256=sha(p)) for p in integrity_paths}
integrity_source = dict(manifest=integrity_manifest, digest=scope["plan_source_digest"](integrity_manifest))
registry_original = (root/"experiments/active_registry.py").read_text(encoding="utf-8")
write("experiments/active_registry.py", registry_original + "\n# integrity change\n")
try:
    scope["verify_plan_execution_source"](str(root), resource_row, integrity_source)
    raise AssertionError("byte-only integrity dependency change accepted")
except ValueError as exc:
    assert "experiments/active_registry.py" in str(exc) and "digest manifest" in str(exc), str(exc)
write("experiments/active_registry.py", registry_original)
# Even genuinely importing publication.py must not consume its unused MANIFEST constant.
write("train.py", original_train + "\nfrom comparison_methods.simmlm.publication import published\n")
publication_paths, _ = scope["plan_source_scope"](str(root), plan, sha(plan))
assert "comparison_methods/simmlm/publication.py" in publication_paths
assert "comparison_methods/simmlm/published_original.json" not in publication_paths and history not in publication_paths
write("train.py", original_train)

# Explicit actual inputs may be JSON under a result directory; never exclude by directory alone.
write("experiments/results/当前 输入.json", '{"input": 1}')
write("train.py", original_train + "\njson.loads(Path('experiments/results/当前 输入.json').read_text())\n")
assert "experiments/results/当前 输入.json" in scope["plan_source_scope"](str(root), plan, sha(plan))[0]
write("train.py", original_train)
write("inputs/current.bin", "actual binary input")
write("train.py", original_train + "\nPath('inputs/current.bin').read_bytes()\n")
assert "inputs/current.bin" in scope["plan_source_scope"](str(root), plan, sha(plan))[0]
write("train.py", original_train)
write(plan, "runner:\n  command: python train.py --config configs/train.json\nsource_dependencies:\n  inputs:\n    - 'experiments/results/当前 输入.json'\n")
assert "experiments/results/当前 输入.json" in scope["plan_source_scope"](str(root), plan, sha(plan))[0]
write(plan, "runner:\n  command: python train.py\nsource_dependencies:\n  inputs:\n    - " + history + "\n")
try:
    scope["plan_source_scope"](str(root), plan, sha(plan))
    raise AssertionError("oversized actual input accepted")
except ValueError as exc:
    assert "PLAN_SOURCE_FILE_TOO_LARGE" in str(exc) and history in str(exc), str(exc)
    assert plan in str(exc) and "source_dependencies" in str(exc), str(exc)
write(plan, "source_dependencies:\n  inputs:\n    - inputs/missing.json\n")
try:
    scope["plan_source_scope"](str(root), plan, sha(plan))
    raise AssertionError("missing declared input accepted")
except ValueError as exc:
    assert "inputs/missing.json" in str(exc), str(exc)
write(plan, "source_dependencies:\n  inputs:\n    - ../outside.json\n")
try:
    scope["plan_source_scope"](str(root), plan, sha(plan))
    raise AssertionError("escaping declared input accepted")
except ValueError as exc:
    assert "PATH_INVALID" in str(exc) or "ESCAPE" in str(exc), str(exc)

# Unknown dynamic reads must not silently disappear. Explicit dependency declarations
# bind the input bytes without changing project training code or executing its loaders.
write("train.py", "from pathlib import Path\ndef read(path):\n    return Path(path).read_bytes()\nread(runtime_input)\n")
write(plan, "runner:\n  command: python train.py\n")
try:
    scope["plan_source_scope"](str(root), plan, sha(plan))
    raise AssertionError("unbounded dynamic input accepted")
except ValueError as exc:
    assert "UNDECLARED" in str(exc) and "source_dependencies" in str(exc), str(exc)
write(plan, "runner:\n  command: python train.py\nsource_dependencies:\n  inputs:\n    - inputs/current.json\n")
assert "inputs/current.json" in scope["plan_source_scope"](str(root), plan, sha(plan))[0]
write("train.py", "import importlib\nimportlib.import_module(runtime_module)\n")
write("plugins/needed.py", "VALUE = 1\n")
write("plugins/unrelated.py", "VALUE = 2\n")
write(plan, "runner:\n  command: python train.py\nsource_dependencies:\n  code:\n    - plugins/needed.py\n  integrity:\n    - experiments/active_registry.py\n")
dynamic_paths, dynamic_scope = scope["plan_source_scope"](str(root), plan, sha(plan))
assert "plugins/needed.py" in dynamic_paths and "plugins/unrelated.py" not in dynamic_paths
assert "experiments/active_registry.py" in dynamic_paths and "comparison_methods/simmlm/publication.py" not in dynamic_paths
assert dynamic_scope

# API-specific file access contracts. Never execute the wrapper or its log writes.
root = original_root / "open-contracts"
root.mkdir()
wrapper = "experiments/simple_adapter/run_wrapper.py"
open_plan = "experiments/plans/comparison/open_contract.yaml"
write("inputs/中文 空格.txt", "original input")
write("inputs/other.txt", "other input")
header = "from pathlib import Path\nstdout_path = Path('logs/stdout.log')\nstderr_path = Path('logs/stderr.log')\n"
reported_line = 'with stdout_path.open("a", encoding="utf-8") as stdout_log, stderr_path.open("a", encoding="utf-8") as stderr_log:\n    pass\n'
wrapper_source = header + "\n" * (180 - len(header.splitlines())) + reported_line
assert wrapper_source.splitlines()[180].startswith("with stdout_path.open")
write(wrapper, wrapper_source)
write(open_plan, "runner:\n  command: python " + wrapper + "\n")
wrapper_paths, _ = scope["plan_source_scope"](str(root), open_plan, sha(open_plan))
assert set(wrapper_paths) == {open_plan, wrapper}, wrapper_paths
assert not (root / "logs").exists() and not (root / "experiments/simple_adapter/a").exists()

open_cases = 1
def open_case(code, reads=False, error=None, declarations="", conservative=False):
    global open_cases
    write("train.py", code)
    write(open_plan, "runner:\n  command: python train.py\n" + declarations)
    try:
        actual, notes = scope["plan_source_scope"](str(root), open_plan, sha(open_plan))
    except ValueError as exc:
        assert error and error in str(exc), (code, str(exc))
        assert "dependency chain" in str(exc), str(exc)
        open_cases += 1
        return
    assert error is None, (code, "expected " + str(error))
    expected = {open_plan, "train.py"} | ({"inputs/中文 空格.txt"} if reads else set())
    assert set(actual) == expected, (code, actual)
    if conservative: assert notes, (code, notes)
    open_cases += 1

for expression in ["p.open('a')", "p.open(mode='a')", "p.open('w')", "p.open(mode='x')"]:
    open_case("from pathlib import Path\np = Path('logs/not-yet-created.log')\n" + expression)
for expression in ["p.open()", "p.open('r')", "p.open(mode='r')", "p.open('rb')", "p.open('r+')", "p.open(mode='a+')", "p.read_text()", "p.read_bytes()"]:
    open_case("from pathlib import Path\np = Path('inputs/中文 空格.txt')\n" + expression, reads=True)
for imports, expression in [
    ("", "open('inputs/中文 空格.txt')"),
    ("", "open(file='inputs/中文 空格.txt', mode='r')"),
    ("import io", "io.open('inputs/中文 空格.txt', 'r+')"),
    ("import io as stream", "stream.open(file='inputs/中文 空格.txt', mode='a+')"),
    ("from io import open as file_open", "file_open('inputs/中文 空格.txt', mode='r')"),
    ("from builtins import open as builtin_open", "builtin_open('inputs/中文 空格.txt')"),
    ("import builtins as core", "core.open('inputs/中文 空格.txt')"),
    ("from pathlib import Path as P", "P('inputs', '中文 空格.txt').open()"),
    ("import pathlib as paths", "paths.Path('inputs/中文 空格.txt').open()"),
    ("import pathlib", "pathlib.Path('inputs/中文 空格.txt').read_text()"),
    ("from pathlib import Path as P", "base=P('inputs')\np=base/'中文 空格.txt'\np.open()"),
    ("", "def reader():\n    from io import open as read_file\n    return read_file('inputs/中文 空格.txt')\n"),
]: open_case(imports + "\n" + expression, reads=True)
for imports, expression in [
    ("", "open('logs/absent', 'a')"),
    ("import io as stream", "stream.open('logs/absent', mode='a')"),
    ("from io import open as file_open", "file_open('logs/absent', 'w')"),
    ("from pathlib import Path as P", "P('logs/absent').open(mode='a')"),
]: open_case(imports + "\n" + expression)

declared_input = "source_dependencies:\n  inputs:\n    - 'inputs/中文 空格.txt'\n"
for expression in ["Path(runtime_path).open()", "unknown.open('a')", "Path('inputs/中文 空格.txt').open(runtime_mode)", "Path('inputs/中文 空格.txt').open(**options)"]:
    code = "from pathlib import Path\n" + expression
    open_case(code, error="UNDECLARED")
    open_case(code, reads=True, declarations=declared_input, conservative=True)
# Mixed known/unknown receiver origins and a shadowed import must not masquerade as Path.
open_case("from pathlib import Path\np = other\np.open('a')", error="UNDECLARED")
open_case("from pathlib import Path as P\ndef reader(P):\n    return P('logs/absent').open('a')\nreader(factory)", error="UNDECLARED")
open_case("from pathlib import Path\nmode='a'\ndef reader(mode):\n    return Path('inputs/中文 空格.txt').open(mode)\nreader(runtime_mode)", error="UNDECLARED")
open_case("from pathlib import Path\nPath = factory\nPath('logs/absent').open('a')", error="UNDECLARED")
open_case("import other_api as io\nio.open('a')", error="UNDECLARED")
open_case("import other_api as io\nio.open('a')", reads=True, declarations=declared_input, conservative=True)
open_case("from pathlib import Path\np = Path('inputs/中文 空格.txt')\nfor p in runtime_receivers:\n    p.open('a')", error="UNDECLARED")
open_case("from pathlib import Path\np = Path(runtime_path)\np.open('a')")
open_case("from pathlib import Path\nmode='a'\nmode='r'\nPath('inputs/中文 空格.txt').open(mode)", reads=True)
open_case("from io import open as file_open\nfile_open('inputs/missing.txt', 'r+')", error="PLAN_SOURCE_MISSING")
open_case("from pathlib import Path\nPath('inputs/missing.txt').open('a+')", error="PLAN_SOURCE_MISSING")
open_case("from pathlib import Path\nPath('../outside.txt').open()", error="PLAN_SOURCE_PATH_INVALID")
open_case("from pathlib import Path\nPath('inputs/中文 空格.txt').open(mode='invalid')", error="PLAN_SOURCE_OPEN_MODE_INVALID")
open_case("from pathlib import Path\nPath('inputs/中文 空格.txt').open('a', mode='r')", error="PLAN_SOURCE_OPEN_ARGUMENT_INVALID")
open_case("from io import open as file_open\nfile_open('inputs/中文 空格.txt', 'a', mode='r')", error="PLAN_SOURCE_OPEN_ARGUMENT_INVALID")
open_case("def open(path, mode):\n    return 1\nopen('not-a-file', 'r')")
# Alias-aware Path forwarding retains actual input and digest verification.
open_case("from pathlib import Path as P\ndef read(path):\n    return P(path).read_bytes()\nread('inputs/中文 空格.txt')", reads=True)
open_case("import hashlib\nfrom pathlib import Path as P\nhashlib.sha256(P('inputs/中文 空格.txt').read_bytes())", reads=True)
final_paths, _ = scope["plan_source_scope"](str(root), open_plan, sha(open_plan))
final_manifest = {p: dict(size=(root/p).stat().st_size, sha256=sha(p)) for p in final_paths}
final_row = dict(projectId="open-contract", planFile=open_plan, planRevision=sha(open_plan))
write("inputs/中文 空格.txt", "changed input")
try:
    scope["verify_plan_execution_source"](str(root), final_row, dict(manifest=final_manifest, digest=scope["plan_source_digest"](final_manifest)))
    raise AssertionError("changed Path alias integrity input accepted")
except ValueError as exc:
    assert "inputs/中文 空格.txt" in str(exc), str(exc)
print(json.dumps(dict(ok=True, files=len(paths), generatedChangesIgnored=6, sourceChangesRejected=3, metadataChainExcluded=True, actualInputsVerified=True, historyPreserved=True, pathOpenCases=open_cases, wrapperLine181=True)))
