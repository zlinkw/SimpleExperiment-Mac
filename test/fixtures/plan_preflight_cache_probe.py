"""Exercise extracted production functions only, with no subprocesses or project mutations."""
import ast
import hashlib
import json
import os
import re
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

request = json.load(sys.stdin)
names = {
    "code_sync_proof_runtime_generation", "code_sync_proof_id", "verify_code_sync_proof_record",
    "plan_structural_validation_key", "plan_validation_with_current_outputs",
    "cached_scheduler_validation", "scheduler_validate_json", "has_existing_artifacts",
    "plan_validation_cache_covers_inputs",
    "plan_preflight_project_path",
}
tree = ast.parse(request["agent"])
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert {node.name for node in selected} == names
markers = next(node for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == "EXISTING_ARTIFACT_MARKERS" for target in node.targets))
scope = dict(globals())
scope.update(AGENT_VERSION="test-agent", RUNTIME_VERSION="test-runtime", PLUGIN_VERSION="test-plugin",
             PLAN_STRUCTURAL_VALIDATION_CACHE={}, PLAN_STRUCTURAL_VALIDATION_CACHE_LOCK=threading.RLock())
exec(compile(ast.Module(body=[markers, *selected], type_ignores=[]), "extracted-preflight", "exec"), scope)
root = os.path.abspath("read-only-preflight-fixture")
plan = "plans/alpha.yaml"
scheduler = os.path.join(root, "runtime", "scheduler.py")
files = {"plans/alpha.yaml": [20, 100], "configs/train.yaml": [40, 200], "models/train.py": [80, 300], "data/input.csv": [1000, 400]}
proofs = {}
environment = {"SIMPLE_EXPERIMENT_CONDA_ENV": "/env/default"}
captures = []
dependency_checks = []
artifacts = {}
stats = []

def safe_path(project, relative):
    full = os.path.abspath(os.path.join(project, relative))
    if os.path.commonpath([full, project]) != project:
        raise ValueError("outside project")
    return full

def stat_file(full, **kwargs):
    if full in (scheduler, sys.executable):
        return SimpleNamespace(st_size=100, st_mtime_ns=500, st_mtime=500 / 1e9)
    relative = os.path.relpath(full, root).replace(os.sep, "/")
    stats.append(relative)
    if relative not in files:
        raise FileNotFoundError(full)
    size, mtime = files[relative]
    return SimpleNamespace(st_size=size, st_mtime_ns=mtime, st_mtime=mtime / 1e9)

class Scan:
    def __init__(self, entries):
        self.entries = entries
    def __enter__(self):
        return iter(SimpleNamespace(name=name, is_file=lambda: True) for name in self.entries)
    def __exit__(self, *args):
        pass

def scan(full):
    relative = os.path.relpath(full, root).replace(os.sep, "/")
    if artifacts.get(relative) == "denied":
        raise PermissionError(relative)
    if relative not in artifacts:
        raise FileNotFoundError(full)
    return Scan(artifacts[relative])

jobs = [dict(index=index, case="dataset", seed=42 + index, output_dir=f"work/job-{index}", inputs=["data/input.csv"]) for index in range(2)]

def capture(*args, **kwargs):
    captures.append(args)
    return SimpleNamespace(returncode=0, stdout=json.dumps(dict(ok=True, job_count=2, jobs=jobs,
        structuralInputPaths=[plan, "configs/train.yaml"], outputInterface=dict(rows=[dict(sourceFiles=["models/train.py"], channels=[])]),
        existing=[dict(index=99, output_dir="old/cached-output")], existingCount=1)), stderr="")

scope.update(safe_project_path=safe_path, code_sync_proof_document=lambda project: dict(proofs=proofs),
             simple_runtime_env=lambda supplied: {**supplied, **environment}, simple_runtime_python=lambda env: sys.executable,
             require_scheduler_dependencies=lambda *args: dependency_checks.append(args), scheduler_capture=capture)

def options(generation="a", omit_plan=False):
    fingerprint = hashlib.sha256(generation.encode()).hexdigest()
    scope_sig = hashlib.sha256(b"scope").hexdigest()
    proof_id = scope["code_sync_proof_id"]("project", fingerprint, fingerprint, scope_sig)
    inventory = [dict(path=name, size=value[0], mtime_ns=value[1]) for name, value in files.items()
                 if not name.startswith("data/") and not (omit_plan and name == plan)]
    proofs[proof_id] = dict(proofId=proof_id, projectId="project", codeFingerprint=fingerprint,
        manifestDigest=fingerprint, scopeSignature=scope_sig, runtimeGeneration=scope["code_sync_proof_runtime_generation"](),
        files=inventory, fileCount=len(inventory))
    return dict(structuralValidationKey=fingerprint, validationCodeProof=dict(projectId="project",
        codeFingerprint=fingerprint, manifestDigest=fingerprint, codeSyncProofId=proof_id))

with patch("os.stat", stat_file), patch("os.path.isfile", lambda full: os.path.relpath(full, root).replace(os.sep, "/") in files), \
     patch("os.path.exists", lambda full: os.path.relpath(full, root).replace(os.sep, "/") in files), \
     patch("os.path.islink", lambda full: False), patch("os.scandir", scan):
    opts = options()
    validate = scope["scheduler_validate_json"]
    cached = scope["cached_scheduler_validation"]
    initial = validate(root, scheduler, plan, options=opts)
    assert len(captures) == len(dependency_checks) == 1
    cache = scope["PLAN_STRUCTURAL_VALIDATION_CACHE"]
    assert len(cache) == 1
    assert all("existing" not in row and "existingCount" not in row for row in cache.values())
    artifacts["work/job-0"] = ["stdout.log"]
    fresh = cached(root, scheduler, plan, options=opts)
    assert fresh["existingCount"] == 1 and fresh["existing"][0]["index"] == 0
    fresh["jobs"].clear()
    artifacts["work/job-1/checkpoints"] = ["latest.ckpt"]
    artifacts["work/job-1"] = ["checkpoints"]
    assert validate(root, scheduler, plan, options=opts)["existingCount"] == 2
    assert len(captures) == len(dependency_checks) == 1, "warm checks must not launch scheduler or dependency subprocesses"
    artifacts.clear()
    assert validate(root, scheduler, plan, options=opts)["existing"] == [], "deleted outputs cannot survive in the cache"
    assert len(captures) == 1
    warm_scheduler_calls = len(captures) - 1
    input_record = files.pop("data/input.csv")
    try:
        cached(root, scheduler, plan, options=opts)
        raise AssertionError("missing declared input must still block a warm validation")
    except ValueError as error:
        assert "data/input.csv" in str(error)
    files["data/input.csv"] = input_record
    artifacts["work/job-0"] = "denied"
    try:
        cached(root, scheduler, plan, options=opts)
        raise AssertionError("artifact stat failure must not become an empty output list")
    except PermissionError:
        pass
    artifacts.clear()
    assert cached(root, scheduler, plan, "other/results", opts) is None
    environment["SIMPLE_EXPERIMENT_CONDA_ENV"] = "/env/changed"
    assert cached(root, scheduler, plan, options=opts) is None
    environment["SIMPLE_EXPERIMENT_CONDA_ENV"] = "/env/default"
    scope["PLUGIN_VERSION"] = "changed-runtime"
    assert cached(root, scheduler, plan, options=opts) is None
    scope["PLUGIN_VERSION"] = "test-plugin"
    assert cached(root, scheduler, plan, options={}) is None, "legacy/missing proof always performs a complete check"
    files["configs/train.yaml"][1] += 1
    assert cached(root, scheduler, plan, options=opts) is None, "remote config edits invalidate the proof"
    validate(root, scheduler, plan, options=opts)
    assert len(captures) == 2
    revised = options("b")
    validate(root, scheduler, plan, options=revised)
    assert len(captures) == 3
    assert cached(root, scheduler, plan, options=revised)["structuralValidationReused"] is True
    assert cached(root, scheduler, plan, options=options("no-plan", omit_plan=True)) is None
    assert not scope["plan_validation_cache_covers_inputs"](root, {**initial, "structuralInputPaths": ["excluded/config.yaml"]}, revised)
    for index in range(40):
        validate(root, scheduler, plan, options=options(f"generation-{index}"))
    assert len(cache) == 32, "bounded LRU without persistent cache files"
    assert cached(root, scheduler, plan, options=opts) is None, "evicted template must revalidate"
    assert "configs/train.yaml" in stats and "models/train.py" in stats

print(json.dumps(dict(ok=True, cacheEntries=len(cache), warmSchedulerCalls=warm_scheduler_calls)))
