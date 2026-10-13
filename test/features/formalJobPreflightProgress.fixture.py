"""Real Worker admission -> subprocess -> extracted real Scheduler; no runtime entry point or training."""
import ast
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

runtime = repo / "dist/runtime"
variant = sys.argv[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-formal-preflight-")).resolve()
(root / "experiments/plans").mkdir(parents=True)
hook = root / "validator.py"
hook.write_text('''import hashlib, json, os, sys, time
processed = 0
files = 0
def validate_result_paths(config, contract):
    global processed, files
    index = contract['index']
    files += 1
    print('SIMPLE_PROGRESS ' + json.dumps({'phase':'assets','processedFiles':files,'processedBytes':processed,'callbackIndex':index}), file=sys.stderr, flush=True)
    variant = os.environ['PROBE_VARIANT']
    if variant == 'exit':
        print('ACTUAL_PREFLIGHT_EXIT_7', file=sys.stderr, flush=True)
        sys.exit(7)
    if variant in ('grow','cancel'):
        digest = hashlib.sha256()
        with open('asset.dat','rb') as asset:
            for chunk in iter(lambda: asset.read(64), b''):
                digest.update(chunk)
                processed += len(chunk)
                print('SIMPLE_PROGRESS ' + json.dumps({'phase':'assets','processedBytes':processed,'processedFiles':files}),file=sys.stderr,flush=True)
                time.sleep(0.015)
        if digest.hexdigest() != os.environ['PROBE_ASSET_SHA256']:
            raise ValueError('SOURCE_HASH_CHANGED')
    if variant in ('stall','heartbeat','decreasing'):
        for number in range(200):
            payload = {'phase': 'heartbeat-'+str(number), 'processedBytes': 0, 'processedFiles': files}
            if variant == 'decreasing': payload['processedFiles'] = 0
            if variant != 'stall': print('SIMPLE_PROGRESS '+json.dumps(payload),file=sys.stderr,flush=True)
            time.sleep(0.01)
    if variant == 'mixed': print('SIMPLE_PROGRESS {"processedBytes": 999999}',flush=True)
''', encoding="utf-8")
(root / "asset.dat").write_bytes(b"owned-asset" * 512)
child = root / "scheduler_probe.py"
child.write_text('''import argparse, json, pathlib, sys
sys.path.insert(0, ''' + repr(str(repo / "test/_helpers")) + ''')
from extractRuntimeFunctions import extract_runtime_functions
scheduler = extract_runtime_functions(''' + repr(str(runtime / "cluster_scheduler.py")) + ''', ['formal_job_preflight_report'])
p = argparse.ArgumentParser()
p.add_argument('--formal-job-preflight',action='store_true')
p.add_argument('--check-execution-shell-json',action='store_true')
p.add_argument('--plan');p.add_argument('--only-index',type=int);p.add_argument('--mode')
p.add_argument('--plan-revision');p.add_argument('--output-dir-override')
p.add_argument('--default-result-csv-dir',default='experiments/results')
args=p.parse_args()
print(json.dumps(scheduler.execution_shell_preflight() if args.check_execution_shell_json else scheduler.formal_job_preflight_report(args),ensure_ascii=False),flush=True)
''', encoding="utf-8")
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["load_plan", "build_jobs", "formal_source_fingerprint"])
plan_file = "experiments/plans/formal.yaml"
plan = {"mode": "train_test", "seeds": [42, 43, 44], "base_config": {"runtime": {}, "test": {}},
        "naming": {"sweep_dir": "work_dirs/formal", "job_name": "{case}_seed{seed}"},
        "paper": {"result_csv": "tmp/result/formal/{case}/seed{seed}/metrics.csv"},
        "runner": {"train_command": "must-never-train", "test_command": "must-never-test --result-csv {result_csv}"},
        "cases": [{"case": "bus"}, {"case": "pad"}]}
if variant == "duplicate": plan["paper"]["result_csv"] = "tmp/result/shared.csv"
(root / plan_file).write_text(scheduler.yaml.safe_dump(plan), encoding="utf-8")
(root / "experiments/simple_project.yaml").write_text("adapter:\n  resultPathValidator: validator.py\n", encoding="utf-8")
os.chdir(root)
loaded = scheduler.load_plan(plan_file)
_, jobs = scheduler.build_jobs(loaded)
index = 3 if variant == "pad" else 0
job = jobs[index]
command = {"schemaVersion": 1, "commandId": "owned-command", "runKey": "owned-command", "workflowId": "owned-workflow",
    "globalJobId": f"owned-workflow:{index}", "projectId": "fixture-project", "workerId": "worker",
    "planFile": plan_file, "planRevision": loaded["_revision"], "codeFingerprint": scheduler.formal_source_fingerprint(root),
    "experimentIndex": index, "case": job.case, "seed": job.seed, "planJobCount": 6, "fullPlanJobCount": 6,
    "enqueuedAt": "2026-10-13T00:00:00Z", "mode": "train_test", "executionMode": "train_test",
    "resultPathPolicy": "declared", "outputDir": job.output_dir, "collectionResultCsv": job.result_csv,
    "durablePlanQueue": True}
if variant == "identity": command["globalJobId"] = "foreign:0"
agent = extract_runtime_functions(str(runtime / "cluster_agent.py"),
    ["accept_durable_plan_job", "subprocess_inactivity_run", "preflight_existing_worker_task"])
def fixture_project_path(base, value, **options):
    # Keep the POSIX contract; map only the native filesystem leaf to retained local fixtures.
    agent.durable_plan_path(value, "fixture POSIX path")
    target = pathlib.Path(base).joinpath(*value.split("/")).resolve()
    assert target.is_relative_to(pathlib.Path(base).resolve())
    if options.get("require_file"):
        assert target.is_file()
    return str(target)
agent.worker_plan_project_path = fixture_project_path
queue, events, stderr, children = {"schemaVersion": 1, "jobs": []}, [], [], []
agent.read_durable_plan_queue = lambda _: copy.deepcopy(queue)
def save(_, value):
    queue.clear(); queue.update(copy.deepcopy(value))
agent.write_durable_plan_queue = save
agent.recalled_worker_command = lambda *args: None
agent.append_event = lambda *args, **kw: None
agent.read_json = lambda *args: {}
agent.path_for = lambda *args: str(root / "not-created.json")
agent.signal_durable_plan_queue_processor = lambda *args: None
agent.cluster_scheduler_path = lambda _: str(child)
agent.formal_job_path_capable = lambda _: True  # The child runs the real Scheduler preflight implementation.
agent.execution_shell_preflight_capable = lambda _: True  # Version rejection is tested separately; this child uses the real extracted probe.
agent.simple_runtime_python = lambda env: sys.executable
agent.scalar_scheduler_module = lambda: scheduler
def environment():
    env = dict(os.environ, PROBE_VARIANT=variant, PYTHONDONTWRITEBYTECODE="1")
    env["PROBE_ASSET_SHA256"] = scheduler.hashlib.sha256((root / "asset.dat").read_bytes()).hexdigest()
    return env
agent.fresh_task_runtime_env = environment
agent.progress_action = lambda *args, **kw: events.append(args[6] if len(args) > 6 else kw)
agent.redact_text = lambda value: value
scale = 30
agent.time = SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith("__") and name not in ("monotonic", "sleep")},
    monotonic=lambda: time.monotonic() * scale, sleep=lambda seconds: time.sleep(min(seconds, 0.005)))
original_run, original_popen = subprocess.run, subprocess.Popen
def scaled_run(*args, **kw):
    if kw.get("timeout") == 10: kw["timeout"] /= scale
    result = original_run(*args, **kw); stderr.append(result.stderr or ""); return result
def popen(*args, **kw):
    proc = original_popen(*args, **kw); children.append(proc); return proc
agent.subprocess = SimpleNamespace(**{name: getattr(subprocess, name) for name in dir(subprocess) if not name.startswith("__")})
agent.subprocess.run = scaled_run
agent.subprocess.Popen = popen
original_inactivity = agent.subprocess_inactivity_run
def inactivity(*args, **kw):
    result = original_inactivity(*args, **kw); stderr.append(result.stderr or ""); return result
agent.subprocess_inactivity_run = inactivity
entry = {"cancel": threading.Event(), "processes": set(), "root": str(root), "action": "preflight-worker-task",
         "operationId": "preflight-op", "opId": "preflight-op", "payload": command}
agent.INACTIVITY_ACTION_CONTEXT.entry = entry
if variant == "cancel": threading.Timer(0.4, entry["cancel"].set).start()
started = time.monotonic()
if variant in ("api", "api-environment"):
    # Frozen never-started admission rejection, verified again without queue mutation.
    raw = hook.read_bytes()
    command["codeManifest"] = {"validator.py": {"size": len(raw), "sha256": agent.hashlib.sha256(raw).hexdigest()}}
    command["codeFingerprint"] = agent.durable_code_manifest_digest(command["codeManifest"])
    row = {**command, "status": "failed", "neverStarted": True, "neverStartedEvidence": "formal_preflight_rejected"}
    if variant == "api-environment":
        row.update(neverStarted=False, neverStartedEvidence="", condaEnv="")
        output = pathlib.Path(job.output_dir)
        output.mkdir(parents=True)
        (output / "failure.log").write_bytes(b"preserve the original failure bytes")
    queue["jobs"] = [row]
    original_queue = copy.deepcopy(queue)
    def forbidden(*args, **kw): raise AssertionError("diagnostic attempted to mutate or launch")
    agent.write_durable_plan_queue = forbidden
    agent.signal_durable_plan_queue_processor = forbidden
    payload = {"targetCommandId": row["commandId"], "expectedIdentity": copy.deepcopy(row)}
    if variant == "api-environment": payload["environmentOnly"] = True
    receipt = agent.preflight_existing_worker_task(str(root), payload, "worker")
    rejections = []
    for change in ({"globalJobId": "foreign:0"}, {"mode": "train"}, {"collectionResultCsv": "other.csv"}):
        bad = copy.deepcopy(payload)
        bad["expectedIdentity"].update(change)
        try:
            agent.preflight_existing_worker_task(str(root), bad, "worker")
            raise AssertionError("changed diagnostic identity was accepted")
        except ValueError as exc: rejections.append(str(exc))
    queue["jobs"][0]["status"] = "running"
    try:
        agent.preflight_existing_worker_task(str(root), payload, "worker")
        raise AssertionError("running task was accepted")
    except ValueError as exc: rejections.append(str(exc))
    queue["jobs"][0]["status"] = "failed"
    hook.write_text(hook.read_text(encoding="utf-8") + "\n# altered\n", encoding="utf-8")
    try:
        agent.preflight_existing_worker_task(str(root), payload, "worker")
        raise AssertionError("changed source hash was accepted")
    except ValueError as exc: rejections.append(str(exc))
    assert queue == original_queue, "diagnostic changed queue or failure status"
    receipt["rejections"] = rejections
else:
    receipt = agent.accept_durable_plan_job(str(root), command, "worker")
callbacks = []
for line in "".join(stderr).splitlines():
    if line.startswith("SIMPLE_PROGRESS "):
        try:
            row = json.loads(line[len("SIMPLE_PROGRESS "):])
            if "callbackIndex" in row: callbacks.append(row["callbackIndex"])
        except ValueError: pass
if variant == "api-environment":
    assert sorted(p.name for p in pathlib.Path(job.output_dir).iterdir()) == ["failure.log"]
    assert (pathlib.Path(job.output_dir) / "failure.log").read_bytes() == b"preserve the original failure bytes"
else:
    assert not pathlib.Path(job.output_dir).exists(), "preflight created a training directory"
assert all(proc.poll() is not None for proc in children), "preflight child is still alive"
assert not entry["processes"], "preflight child remained registered"
print(json.dumps({"receipt": receipt, "callbacks": callbacks, "progressCount": len(events),
                  "elapsedVirtualSeconds": (time.monotonic() - started) * scale, "executionStarted": False}))
