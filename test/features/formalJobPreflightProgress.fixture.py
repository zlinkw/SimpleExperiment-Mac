"""Real Worker admission -> subprocess -> extracted real Scheduler; no runtime entry point or training."""
import ast
import copy
import contextlib
import io
import json
import marshal
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
from extractRuntimeFunctions import compile_runtime_functions, extract_runtime_functions

runtime = repo / "dist/runtime"
variant = sys.argv[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-formal-preflight-")).resolve()
(root / "experiments/plans").mkdir(parents=True)
hook = root / "validator.py"
hook.write_text('''import hashlib, json, os, pathlib, sys, time
processed = 0
files = 0
def validate_result_paths(config, contract):
    global processed, files
    index = contract['index']
    files += 1
    print('SIMPLE_PROGRESS ' + json.dumps({'phase':'assets','processedFiles':files,'processedBytes':processed,'callbackIndex':index}), file=sys.stderr, flush=True)
    variant = os.environ['PROBE_VARIANT']
    if os.environ.get('PROBE_WATCHDOG_READY'):
        pathlib.Path(os.environ['PROBE_WATCHDOG_READY']).write_text('ready', encoding='utf-8')
    if variant == 'exit':
        print('ACTUAL_PREFLIGHT_EXIT_7', file=sys.stderr, flush=True)
        sys.exit(7)
    if variant not in ('stall','heartbeat','decreasing','exit'):
        digest = hashlib.sha256()
        with open('asset.dat','rb') as asset:
            for chunk in iter(lambda: asset.read(64), b''):
                digest.update(chunk)
                processed += len(chunk)
                print('SIMPLE_PROGRESS ' + json.dumps({'phase':'assets','processedBytes':processed,'processedFiles':files}),file=sys.stderr,flush=True)
                if variant in ('grow','cancel'): time.sleep(0.015)
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
asset_sha256 = __import__('hashlib').sha256((root / "asset.dat").read_bytes()).hexdigest()
child = root / "scheduler_probe.py"
# AST dependency extraction is fixture preparation, rather than Worker startup or asset progress.
# Prepare exactly the real selected functions once, before the scaled inactivity clock begins.
# The child still starts a real interpreter, imports the real dependencies, and executes those
# functions in its own module. No entry point/full runtime is imported or executed, and no fake
# heartbeat is emitted to extend the production watchdog.
prepared_scheduler = root / "scheduler_selected.marshal"
prepared_scheduler.write_bytes(marshal.dumps(compile_runtime_functions(
    str(runtime / "cluster_scheduler.py"), ["formal_job_preflight_report", "execution_shell_preflight"])))
child.write_text('''import argparse, json, marshal, os, pathlib, sys, types
TASK_SHELL_ENVIRONMENT_PROTOCOL = 1
scheduler = types.ModuleType('isolated_runtime')
scheduler.__file__ = ''' + repr(str(runtime / "cluster_scheduler.py")) + '''
sys.modules[scheduler.__name__] = scheduler
exec(marshal.loads(pathlib.Path(''' + repr(str(prepared_scheduler)) + ''').read_bytes()), scheduler.__dict__)
if os.environ.get('PROBE_VARIANT') == 'no-environment':
 def forbidden_environment_probe(): raise AssertionError('automatic environment probe invoked')
 scheduler.execution_shell_preflight = forbidden_environment_probe
p = argparse.ArgumentParser()
p.add_argument('--formal-job-preflight',action='store_true')
p.add_argument('--formal-job-structure-only',action='store_true')
p.add_argument('--check-execution-shell-json',action='store_true')
p.add_argument('--plan');p.add_argument('--only-index',type=int);p.add_argument('--mode')
p.add_argument('--plan-revision');p.add_argument('--output-dir-override')
p.add_argument('--default-result-csv-dir',default='experiments/results')
args=p.parse_args()
# Explicit fixture-only CPU progress probe exercises the real inactivity runner.
# Production result_path_preflight must never import this project callback.
if not args.formal_job_structure_only and os.environ.get('PROBE_VARIANT') in ('grow','cancel','stall','heartbeat','decreasing','exit','mixed'):
 source=pathlib.Path('validator.py').read_text(encoding='utf-8').replace('def validate_result_paths(', 'def progress_probe(').replace("'callbackIndex':index", "'probeIndex':index")
 scope={}
 exec(compile(source,'fixture-progress-only','exec'),scope)
 scope['progress_probe']({}, {'index':args.only_index})
print(json.dumps(scheduler.execution_shell_preflight() if args.check_execution_shell_json else scheduler.formal_job_preflight_report(args),ensure_ascii=False),flush=True)
''', encoding="utf-8")
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["load_plan", "build_jobs", "formal_source_fingerprint", "run_job_mode"])
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
    ["accept_durable_plan_job", "subprocess_inactivity_run", "preflight_existing_worker_task", "drain_durable_plan_queue_once", "_execute_worker_command_unfenced"])
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
    env["PROBE_ASSET_SHA256"] = asset_sha256
    return env
agent.fresh_task_runtime_env = environment
agent.progress_action = lambda *args, **kw: events.append(args[6] if len(args) > 6 else kw)
agent.redact_text = lambda value: value
# r100（GPT 实施许可，简报 §20）：零进度子进程变体不承担"压缩超时"验证职责，其看门狗窗口恢复产品真实
# 30 秒——结构性竞争：×30 缩放只压缩窗口、不压缩解释器/AST 启动真实耗时（starting 仅证明未记录到有效
# 进度，不区分启动与提取各自耗时）。stall 族与 identity 保持 ×30；消费者断言、轮询、定时器、执行预算不动。
scale = 1 if variant in ("no-environment", "api", "api-environment", "api-completed", "fast", "duplicate", "pad", "staged") else 30
agent.time = SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith("__") and name not in ("monotonic", "sleep")},
    monotonic=lambda: time.monotonic() * scale, sleep=lambda seconds: time.sleep(min(seconds, 0.005)))
# The inactivity variants use a controlled clock after their real probe starts.
# Interpreter/AST startup and reader teardown remain real and bounded by the outer
# 10s child limit; they are not multiplied into the virtual watchdog deadline.
controlled_watchdog = variant in ("grow", "cancel", "stall", "heartbeat", "decreasing", "exit", "mixed")
watchdog_clock = [0.0]
watchdog_ready_files = []
current_watchdog_ready = [None]
if controlled_watchdog:
    def watchdog_sleep(seconds):
        if current_watchdog_ready[0] is not None and current_watchdog_ready[0].exists():
            watchdog_clock[0] += seconds * 3
        time.sleep(min(seconds, 0.005))
    agent.time.monotonic = lambda: watchdog_clock[0]
    agent.time.sleep = watchdog_sleep
original_run, original_popen = subprocess.run, subprocess.Popen
def scaled_run(*args, **kw):
    if kw.get("timeout") == 10: kw["timeout"] /= scale
    result = original_run(*args, **kw); stderr.append(result.stderr or ""); return result
def popen(*args, **kw):
    if controlled_watchdog:
        ready = root / ("fixture-watchdog-ready-" + str(len(children)))
        current_watchdog_ready[0] = ready
        watchdog_ready_files.append(ready)
        kw["env"] = dict(kw.get("env") or os.environ, PROBE_WATCHDOG_READY=str(ready))
    proc = original_popen(*args, **kw); children.append(proc); return proc
agent.subprocess = SimpleNamespace(**{name: getattr(subprocess, name) for name in dir(subprocess) if not name.startswith("__")})
agent.subprocess.run = scaled_run
agent.subprocess.Popen = popen
inactivity_durations = []
original_inactivity = agent.subprocess_inactivity_run
def inactivity(*args, **kw):
    phase_started = time.monotonic()
    try:
        result = original_inactivity(*args, **kw); stderr.append(result.stderr or ""); return result
    finally:
        inactivity_durations.append((time.monotonic() - phase_started) * scale)
agent.subprocess_inactivity_run = inactivity
entry = {"cancel": threading.Event(), "processes": set(), "root": str(root), "action": "preflight-worker-task",
         "operationId": "preflight-op", "opId": "preflight-op", "payload": command}
agent.INACTIVITY_ACTION_CONTEXT.entry = entry
if variant == "cancel": threading.Timer(0.4, entry["cancel"].set).start()
started = time.monotonic()
if variant == "staged":
    # Real admission/drain/start functions. The tmux boundary is deliberately closed;
    # final Scheduler path validation uses a sentinel instead of a training command.
    command.update(action="start-worker-task", condaEnv="/fixture", schedulerPath=str(child))
    original_command_env = agent.formal_job_command_env
    def native_probe_env(value):
        # Native CPU fixture uses the current interpreter, rather than a POSIX conda installation.
        env = original_command_env(value)
        env.pop("SIMPLE_EXPERIMENT_CONDA_ENV", None)
        env.pop("SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV", None)
        return env
    agent.formal_job_command_env = native_probe_env
    def callbacks_so_far():
        return sum('"callbackIndex"' in line for line in "".join(stderr).splitlines())
    receipt = agent.accept_durable_plan_job(str(root), command, "worker")
    assert receipt.get("durableAccepted") is True, receipt
    assert callbacks_so_far() == 0, "admission ran expensive assets before a GPU was available"
    for other in jobs[1:3]:
        other_command = {**command, "commandId": "owned-command-" + str(other.index), "runKey": "owned-command-" + str(other.index),
            "globalJobId": "owned-workflow:" + str(other.index), "experimentIndex": other.index,
            "case": other.case, "seed": other.seed, "outputDir": other.output_dir, "collectionResultCsv": other.result_csv}
        assert agent.accept_durable_plan_job(str(root), other_command, "worker")["durableAccepted"] is True
    agent.reconcile_worker_task_exit_codes = lambda *args: None
    agent.sync_durable_plan_task_rows = lambda _: copy.deepcopy(queue)
    agent.resolve_durable_code_sync_proof = lambda *args: {}
    agent._durable_gpu_busy_reason = lambda *args, **kw: "busy"
    before_busy_children = len(children)
    for _ in range(3):
        probes = []
        def gpu_hint():
            probes.append(True)
            return ([{"id": "0"}], "")
        agent.drain_durable_plan_queue_once(str(root), "worker", gpu_probe=gpu_hint)
        assert len(probes) == 1, "busy queue rescanned GPU telemetry for every waiting job"
    assert callbacks_so_far() == 0, "busy polling repeated expensive asset verification"
    assert len(children) == before_busy_children, "busy queue spawned one Scheduler for every waiting job"
    assert queue["jobs"][0]["commandId"] == command["commandId"]
    assert queue["jobs"][0]["status"] == "queued"
    # A free hint cannot authorize launch when the later mandatory fresh probe is busy.
    freshness_probes = []
    def changing_gpu():
        freshness_probes.append(True)
        return ([{"id": "0", "becameBusy": len(freshness_probes) > 1}], "")
    agent._durable_gpu_busy_reason = lambda _root, _gpu, _command, gpus, *args, **kw: "busy" if gpus[0].get("becameBusy") else ""
    def forbidden_launch(*args): raise AssertionError("a stale GPU hint authorized execution")
    assert not agent.drain_durable_plan_queue_once(str(root), "worker", gpu_probe=changing_gpu,
        execute=forbidden_launch, target_command_id=command["commandId"])
    assert len(freshness_probes) == 2 and queue["jobs"][0]["status"] == "queued"
    assert not agent.DISTRIBUTED_GPU_RESERVATIONS
    agent.agent_install_dir = lambda _: str(root)
    agent.worker_task_console_log = lambda _: "tmp/probe/console.log"
    def forbidden_dependency_gate(*args): raise AssertionError('automatic dependency gate invoked')
    agent.require_scheduler_dependencies = forbidden_dependency_gate
    agent.tmux_available = lambda: False
    try:
        agent._execute_worker_command_unfenced(str(root), {**command, "durablePlanQueue": False, "gpuId": "0"}, "worker")
        raise AssertionError("tmux boundary unexpectedly opened")
    except RuntimeError as exc:
        assert "refusing silent bash fallback" in str(exc), exc
    assert callbacks_so_far() == 0, "actual startup invoked project science"
    args = SimpleNamespace(debug_mode=False, plan=plan_file, plan_revision=loaded["_revision"],
        mode="train_test", only_index=index, output_dir_override=job.output_dir,
        default_result_csv_dir="experiments/results", worker_id="worker", gpu_ids="", resume=False)
    previous = dict(os.environ)
    capture = io.StringIO()
    reached = []
    os.environ.update(environment())
    os.environ.update(SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS="1")
    scheduler.run_job = lambda selected, _: reached.append(selected.index)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(capture):
            scheduler.run_job_mode(args)
    finally:
        os.environ.clear(); os.environ.update(previous)
    stderr.append(capture.getvalue())
    assert reached == [index]
    assert callbacks_so_far() == 0, "Scheduler writer invoked project science"
    # A later PLAN change must still fail at the real gate, before tmux creation.
    # Scientific assets are deliberately not inspected by this plugin gate.
    (root / plan_file).write_text((root / plan_file).read_text(encoding="utf-8") + "\n# changed declaration\n", encoding="utf-8")
    frozen_queue = copy.deepcopy(queue)
    try:
        agent.verified_formal_job_command(str(root), command)
        raise AssertionError("changed PLAN entered the launch boundary")
    except ValueError as error:
        assert "PLAN_REVISION_CHANGED" in str(error), error
    assert queue == frozen_queue, "read-only startup probe altered the queue"
    assert queue["jobs"][0]["commandId"] == command["commandId"]
    assert not agent.DISTRIBUTED_GPU_RESERVATIONS, "proven never-started gate kept its own reservation"
    receipt.update(admissionAssetChecks=0, busyPollAssetChecks=0, startupAssetChecks=0, finalAssetChecks=0)
elif variant == "api-completed":
    raw = hook.read_bytes()
    command["codeManifest"] = {"validator.py": {"size": len(raw), "sha256": agent.hashlib.sha256(raw).hexdigest()}}
    command["codeFingerprint"] = agent.durable_code_manifest_digest(command["codeManifest"])
    previous_identity = os.environ.get("SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY")
    os.environ["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"] = json.dumps(command)
    try:
        with scheduler.formal_job_writer(job, command, "train_test"):
            scheduler.write_job_config(job)
            result_file = pathlib.Path(job.result_csv)
            result_file.parent.mkdir(parents=True)
            result_file.write_text("metric,value\ncustom,0.7\n", encoding="utf-8")
    finally:
        if previous_identity is None: os.environ.pop("SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY", None)
        else: os.environ["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"] = previous_identity
    row = {**command, "status": "completed", "exitCode": 0}
    queue["jobs"] = [row]
    frozen_queue = copy.deepcopy(queue)
    preserved = {str(path): path.read_bytes() for path in pathlib.Path(job.output_dir).rglob("*") if path.is_file()}
    payload = {"targetCommandId": row["commandId"], "expectedIdentity": copy.deepcopy(row), "completedOutputVerify": True}
    receipt = agent.preflight_existing_worker_task(str(root), payload, "worker")
    assert receipt["report"]["completed"] is True
    assert queue == frozen_queue
    assert preserved == {str(path): path.read_bytes() for path in pathlib.Path(job.output_dir).rglob("*") if path.is_file()}
    result_file.write_text("metric,value\ncustom,0.1\n", encoding="utf-8")
    try:
        agent.preflight_existing_worker_task(str(root), payload, "worker")
        raise AssertionError("modified completed result was adopted")
    except ValueError as error:
        assert "COMPLETION_CHANGED" in str(error), error
    receipt["changedResultRejected"] = True
elif variant in ("api", "api-environment"):
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
    if receipt.get("status") == "queued":
        try:
            agent.verified_formal_job_command(str(root), command)
        except Exception as exc:
            receipt = agent.durable_plan_preflight_failure(command, exc, accepted=True)
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
elif variant != "api-completed":
    assert not pathlib.Path(job.output_dir).exists(), "preflight created a training directory"
assert all(proc.poll() is not None for proc in children), "preflight child is still alive"
assert not entry["processes"], "preflight child remained registered"
print(json.dumps({"receipt": receipt, "callbacks": callbacks, "progressCount": len(events),
                  "elapsedVirtualSeconds": watchdog_clock[0] if controlled_watchdog else (time.monotonic() - started) * scale, "elapsedTotalVirtualSeconds": (time.monotonic() - started) * scale, "watchdogReady": any(file.exists() for file in watchdog_ready_files), "inactivityDurations": inactivity_durations, "variant": variant, "executionStarted": False}))
