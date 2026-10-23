"""Extracted production Scheduler/Agent contract replay; no entry points or GPU."""
import copy
import io
import json
import os
import pathlib
import sys
import tempfile
import types
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"),
    ["build_jobs", "load_plan", "formal_job_preflight_mode", "formal_job_writer", "run_job", "formal_source_fingerprint", "launch_experiment", "collect_tensorboard_metrics", "jobs_for_args", "wrapper_context"])
agent = extract_runtime_functions(str(runtime / "cluster_agent.py"),
    ["verified_formal_job_command", "accept_durable_plan_job", "prepare_draft_run_plan", "write_durable_plan_queue", "drain_durable_plan_queue_once", "requeue_durable_plan_job"])
# 非 Windows 上正式运行参数会被 simple_conda_wrapped_args→task_shell_args 包成登录 shell 重绑命令（nt 直接透传）。
# 本夹具回放正式预检的消息契约，fake RPC 必须拿到裸参数列表；shell 重绑行为由 executionShellEnvironment 专测钉住。
agent.simple_conda_wrapped_args = lambda args, env: args
# Retain small isolated fixtures for inspection; no deletion executor is invoked.
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-formal-contract-")).resolve()
os.chdir(root)
(root / "experiments/plans").mkdir(parents=True)
(root / "train.py").write_text("# fixture entry point, never executed\n", encoding="utf-8")
(root / "test.py").write_text("# fixture entry point, never executed\n", encoding="utf-8")
plan = {"suite": "formal", "mode": "train_test", "seeds": [42, 43, 44],
        "base_config": {"runtime": {}, "test": {}, "data": {"split": "fixture"}},
        "naming": {"sweep_dir": "work_dirs/formal", "job_name": "{case}/seed{seed}"},
        "paper": {"result_csv": "tmp/result/formal/{case}/seed{seed}/metrics.csv"},
        "runner": {"train_command": "train-fixture", "test_command": "test-fixture --result-csv {result_csv}", "collect_metrics": False},
        "cases": [{"case": "one"}]}
plan_file = "experiments/plans/formal.yaml"
(root / plan_file).write_text(scheduler.yaml.safe_dump(plan), encoding="utf-8")
loaded = scheduler.load_plan(plan_file)
_, jobs = scheduler.build_jobs(loaded)
identity = {"workflowId": "workflow-formal", "commandId": "command-formal", "globalJobId": "workflow-formal:0",
            "planRevision": loaded["_revision"], "codeFingerprint": scheduler.formal_source_fingerprint(root)}
command = {**identity, "projectId": "project-fixture", "planFile": plan_file, "workerId": "worker",
           "experimentIndex": 0, "case": "one", "seed": 42, "runKey": identity["commandId"],
           "planJobCount": 3, "executionMode": "train_test", "mode": "train_test", "resultPathPolicy": "declared",
           "outputDir": jobs[0].output_dir, "collectionResultCsv": jobs[0].result_csv,
           "schedulerPath": "simple_cluster/runtime/cluster_scheduler.py"}

def scheduler_rpc(argv, **kw):
    assert kw["progress_stream"] == "stderr" and kw["cwd"] == str(root)
    args = SimpleNamespace(plan=argv[argv.index("--plan") + 1], only_index=int(argv[argv.index("--only-index") + 1]),
        mode=argv[argv.index("--mode") + 1], plan_revision=argv[argv.index("--plan-revision") + 1],
        output_dir_override=argv[argv.index("--output-dir-override") + 1], default_result_csv_dir="experiments/results")
    with patch.dict(os.environ, kw["env"]):
        try:
            result = scheduler.formal_job_preflight_mode(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr="")
        except (ValueError, SystemExit) as exc:
            return SimpleNamespace(returncode=1, stdout="", stderr=str(exc))

queue = {"schemaVersion": 1, "jobs": []}
def persist(_, value):
    queue.clear()
    queue.update(copy.deepcopy(value))

def read_queue(_):
    restored = copy.deepcopy(queue)
    for row in restored["jobs"]:
        if row.get("resultPathPolicy") == "declared":
            row["attempt"] = 0
    return restored

with patch.object(agent, "cluster_scheduler_path", lambda _: str(runtime / "cluster_scheduler.py")), \
     patch.object(agent, "subprocess_inactivity_run", scheduler_rpc), \
     patch.object(agent, "simple_runtime_env", lambda value: value), \
     patch.object(agent, "simple_runtime_python", lambda _: sys.executable), \
     patch.object(agent, "read_durable_plan_queue", read_queue), \
     patch.object(agent, "durable_plan_queue_path", lambda _: "fixture-queue.json"), \
     patch.object(agent, "atomic_write", persist), \
     patch.object(agent, "recalled_worker_command", lambda *a: None), \
     patch.object(agent, "signal_durable_plan_queue_processor", lambda *a: None), \
     patch.object(agent, "append_event", lambda *a: None), \
     patch.object(agent, "verified_durable_execution_mode", lambda *a: "train_test"):
    report = agent.verified_formal_job_command(str(root), command)
    assert report["collectionResultCsv"] == jobs[0].result_csv
    assert not list((root / "work_dirs").rglob("*")) if (root / "work_dirs").exists() else True
    first = agent.accept_durable_plan_job(str(root), command, "worker")
    assert first["durableAccepted"] and len(queue["jobs"]) == 1
    assert "attempt" not in queue["jobs"][0]
    assert "attempt" not in first and first["globalJobId"] == command["globalJobId"]
    assert "attempt" not in agent.durable_plan_public_task(queue["jobs"][0])
    assert agent.durable_plan_same_identity(queue["jobs"][0], command), (agent.durable_plan_identity(queue["jobs"][0]), agent.durable_plan_identity(command))
    agent.accept_durable_plan_job(str(root), command, "worker")
    assert len(queue["jobs"]) == 1
    saved_queue = copy.deepcopy(queue)
    with patch.object(agent, "read_json", lambda *a: {}), \
         patch.object(agent, "write_worker_recall_tombstone", lambda _, receipt: receipt), \
         patch.object(agent, "release_distributed_gpu_reservation", lambda *a: None), \
         patch.object(agent, "append_worker_task", lambda *a: None):
        released = agent.requeue_durable_plan_job(str(root), {**command, "commandId": "stop-formal", "targetCommandId": command["commandId"], "gpuId": ""})
        assert released["durableReleased"] and released["neverStarted"] and "attempt" not in released
        assert released["globalJobId"] == command["globalJobId"]
        assert queue["jobs"][0]["status"] == "cancelled" and "attempt" not in queue["jobs"][0]
    persist(None, saved_queue)

    # An old Scheduler cannot advertise or admit the formal-path protocol.
    with patch("builtins.open", __import__("unittest.mock", fromlist=["mock_open"]).mock_open(read_data='RUNTIME_VERSION = "0.0.1"\n')):
        assert agent.formal_job_path_capable(str(root)) is False
        try:
            agent.verified_formal_job_command(str(root), command)
        except ValueError as exc:
            assert "WORKER_PROTOCOL_INCOMPATIBLE" in str(exc)
        else:
            raise AssertionError("old Scheduler was accepted")

    old = {**command,"status":"queued","resultPathPolicy":"attempt","attempt":1,"outputDir":"work/attempts/old"}
    with patch.object(agent,"reconcile_worker_task_exit_codes",lambda *a: None), \
         patch.object(agent,"sync_durable_plan_task_rows",lambda *a: {"jobs":[old]}), \
         patch.object(agent,"verified_formal_job_command",side_effect=AssertionError("historical queue executed")):
        assert agent.drain_durable_plan_queue_once(str(root),"worker",gpu_probe=lambda: (_ for _ in ()).throw(AssertionError("GPU probed"))) == []
    for mutated in ({**command, "commandId": "different", "runKey": "different"},
                    {**command, "outputDir": jobs[0].output_dir + "/attempts/old"},
                    {**command, "collectionResultCsv": "tmp/result/stale.csv"},
                    {**command, "overwriteExisting": True},
                    {**command, "checkpointSource": {"checkpoint_sha256": "changed"}}):
        try:
            rejected = agent.accept_durable_plan_job(str(root), mutated, "worker")
        except ValueError:
            pass
        else:
            assert rejected["durableAccepted"] is False and rejected["admissionRejected"] is True
            assert rejected["neverStarted"] and rejected["status"] == "failed"
    assert len([row for row in queue["jobs"] if row["status"] == "queued"]) == 1

def fails(callback, token):
    try:
        callback()
    except (ValueError, RuntimeError, SystemExit) as exc:
        assert token in str(exc), (token, str(exc))
    else:
        raise AssertionError("expected " + token)

job = jobs[0]
assert len({item.output_dir for item in jobs}) == len({item.result_csv for item in jobs}) == 3
worker = {"id":"worker","project_dir":str(root),"conda_env":"fixture-env",
          "_availability":{"declaredJobPaths":True,"formalJobIdentityEnv":1,"runtimeVersion":scheduler.RUNTIME_VERSION},
          "_availability_received_monotonic":scheduler.time.monotonic()}
with patch.object(scheduler,"scheduler_agent_state_dir",lambda: root/"fixture-hub-state"), \
     patch.object(scheduler.urllib.request,"urlopen",side_effect=AssertionError("unexpected server access")):
    scheduler.launch_experiment(worker,plan_file,0,"0",pathlib.Path("fixture-logs"),mode="train_test",case_name="one",seed=42,
                               workflow_id=identity["workflowId"],output_dir=job.output_dir)
    message = json.loads((root/"fixture-hub-state/worker_commands_worker.jsonl").read_text(encoding="utf-8").strip())
    assert message["collectionResultCsv"] == job.result_csv and "attempt" not in message
    fails(lambda: scheduler.enqueue_worker_command({**worker,"_availability":{},"_availability_received_monotonic":0},message),"WORKER_PROTOCOL_UNVERIFIED")
with scheduler.formal_job_writer(job, identity, "train"):
    fails(lambda: scheduler.formal_job_writer(job, identity, "train").__enter__(), "FORMAL_JOB_CONFLICT")
    (root / job.output_dir / "best_model.pth").write_bytes(b"fixture checkpoint")
    (root / job.output_dir / "config_snapshot.yaml").write_text(scheduler.yaml.safe_dump(job.config), encoding="utf-8")
assert scheduler.formal_job_preflight(job, identity, "train")["completed"]
assert scheduler.formal_job_preflight(job, {**identity, "commandId": "test-command"}, "test")["checkpointVerified"]
with scheduler.formal_job_writer(job, {**identity, "commandId": "test-command"}, "test"):
    (root / job.result_csv).parent.mkdir(parents=True)
    (root / job.result_csv).write_text("metric,value\naccuracy,0.75\n", encoding="utf-8")
assert scheduler.formal_job_preflight(job, {**identity, "commandId": "test-command"}, "test")["completed"]
fails(lambda: scheduler.formal_job_preflight(job, {**identity, "commandId": "other-command"}, "train_test"), "FORMAL_JOB_CONFLICT")
(root / job.result_csv).write_text("tampered", encoding="utf-8")
fails(lambda: scheduler.formal_job_preflight(job, {**identity, "commandId": "test-command"}, "test"), "FORMAL_JOB_COMPLETION_CHANGED")

# Failed directories do not mint another path, even on a different Worker.
second = jobs[1]
second_id = {**identity, "globalJobId": "workflow-formal:1", "commandId": "failed-command"}
try:
    with scheduler.formal_job_writer(second, second_id, "train_test"):
        (root / second.output_dir / "stderr.log").write_text("fixture failure", encoding="utf-8")
        raise RuntimeError("fixture failure")
except RuntimeError:
    pass
fails(lambda: scheduler.formal_job_preflight(second, {**second_id, "commandId": "retry-command"}, "train_test"), "FORMAL_JOB_CONFLICT")
fails(lambda: agent.prepare_draft_run_plan(str(root), "tmp/plan/old.yaml", True), "DRAFT_EXECUTION_RETIRED")
assert agent.prepare_draft_run_plan(str(root), plan_file, False) == plan_file

# An explicit checkpoint source may be read for a new test-only formal job.
test_plan = {**plan, "mode": "test", "seeds": [42], "naming": {"sweep_dir": "work_dirs/formal-test", "job_name": "{case}/seed{seed}"},
             "paper": {"result_csv": "tmp/result/formal-test/{case}/seed{seed}/metrics.csv"}}
(root / "experiments/plans/test.yaml").write_text(scheduler.yaml.safe_dump(test_plan), encoding="utf-8")
_, test_jobs = scheduler.build_jobs(scheduler.load_plan("experiments/plans/test.yaml"))
third = test_jobs[0]
source = {"checkpoint_path": job.output_dir + "/best_model.pth", "config_path": job.output_dir + "/config_snapshot.yaml",
          "plan_file": plan_file, "plan_revision": loaded["_revision"], "code_fingerprint": identity["codeFingerprint"]}
source["checkpoint_sha256"] = scheduler.formal_job_file_hash(root / source["checkpoint_path"])
source["config_sha256"] = scheduler.formal_job_file_hash(root / source["config_path"])
# Match the source seed/config exactly, while preserving the new formal output binding.
third_cfg = copy.deepcopy(third.config)
third_cfg["test"]["checkpoint"] = source["checkpoint_path"]
third_cfg["runtime"]["checkpoint_source"] = source
third = scheduler.replace(third, config=third_cfg)
third_id = {**identity, "workflowId": "workflow-test", "globalJobId": "workflow-test:0", "commandId": "test-only-command",
            "planRevision": third.template_values["plan_revision"]}
assert scheduler.formal_job_preflight(third, third_id, "test")["checkpointVerified"]
third_cfg["data"]["split"] = "different-patients"
fails(lambda: scheduler.formal_job_preflight(third, third_id, "test"), "FORMAL_CHECKPOINT_CONFIG_OR_CODE_CHANGED")
third_cfg["data"]["split"] = "fixture"
resume = scheduler.replace(third,train_command="train-fixture --resume " + source["checkpoint_path"])
assert scheduler.formal_job_preflight(resume,third_id,"train")["checkpointVerified"]
no_proof = copy.deepcopy(third_cfg); no_proof["runtime"].pop("checkpoint_source")
fails(lambda: scheduler.formal_job_preflight(scheduler.replace(resume,config=no_proof),third_id,"train"),"FORMAL_CHECKPOINT_PROOF_REQUIRED")

# Replay a declared test-only message against the real original PLAN and source evidence.
test_plan["base_config"] = copy.deepcopy(third_cfg)
test_file = "experiments/plans/test.yaml"
(root/test_file).write_text(scheduler.yaml.safe_dump(test_plan),encoding="utf-8")
_, test_jobs = scheduler.build_jobs(scheduler.load_plan(test_file)); third = test_jobs[0]
third_id["planRevision"] = third.template_values["plan_revision"]
test_command = {**command,**third_id,"planFile":test_file,"mode":"test","executionMode":"test","planJobCount":1,
                "outputDir":third.output_dir,"collectionResultCsv":third.result_csv,"checkpointSource":source,"runKey":third_id["commandId"]}
# 移植后 Agent 不再在宿主侧解析 Plan 路径（worker_plan_project_path/durable_plan_path 已删除，
# Plan 存在性与路径安全由真实 Scheduler 的 load_plan 在子进程内把关），夹具不再注入该解析器。
with patch.object(agent,"cluster_scheduler_path",lambda _: str(runtime/"cluster_scheduler.py")), \
     patch.object(agent,"scalar_scheduler_module",lambda:scheduler), \
     patch.object(agent.subprocess,"run",scheduler_rpc), \
     patch.object(agent,"simple_runtime_env",lambda value:value), patch.object(agent,"simple_runtime_python",lambda _:sys.executable), \
     patch.object(agent,"read_durable_plan_queue",read_queue), patch.object(agent,"durable_plan_queue_path",lambda _:"fixture-queue.json"), \
     patch.object(agent,"atomic_write",persist), patch.object(agent,"recalled_worker_command",lambda *a:None), \
     patch.object(agent,"signal_durable_plan_queue_processor",lambda *a:None), patch.object(agent,"append_event",lambda *a:None):
    assert agent.verified_formal_job_command(str(root),test_command)["checkpointVerified"]
    admitted_test = agent.accept_durable_plan_job(str(root),test_command,"worker")
    assert admitted_test["durableAccepted"], admitted_test
    with scheduler.formal_job_writer(third,third_id,"test"):
        (root/third.result_csv).parent.mkdir(parents=True)
        (root/third.result_csv).write_text("metric,value\naccuracy,0.5\n",encoding="utf-8")
    with patch.object(agent,"reconcile_worker_task_exit_codes",lambda *a:None), \
         patch.object(agent,"sync_durable_plan_task_rows",lambda *a:{"jobs":[read_queue(None)["jobs"][-1]]}), \
         patch.object(agent,"resolve_durable_code_sync_proof",lambda *a:{"proofId":"fixture", "manifestDigest":identity["codeFingerprint"], "runtimeGeneration":"fixture-runtime"}), \
         patch.object(agent,"append_worker_task",lambda *a:None):
        restored = agent.drain_durable_plan_queue_once(str(root),"worker",gpu_probe=lambda: (_ for _ in ()).throw(AssertionError("GPU probed on completed job")))
        assert restored[0]["status"] == "completed"
        renewed = read_queue(None)["jobs"][-1]
        assert renewed["codeSyncProofId"] == "fixture"
        assert renewed["manifestDigest"] == identity["codeFingerprint"]
        assert renewed["codeSyncProofRuntimeGeneration"] == "fixture-runtime"
assert not list(root.rglob("attempts"))
# TensorBoard sees the original immutable Job config, rather than the injected copy.
# Its diagnostic rows must still bind the actual formal command, without attempts.
class Scalar:
    value = 0.91
    step = 7
class Accumulator:
    def __init__(self, *args, **kwargs): pass
    def Reload(self): pass
    def Tags(self): return {"scalars": ["AUC"]}
    def Scalars(self, tag): return [Scalar()]
fake = types.ModuleType("tensorboard.backend.event_processing.event_accumulator")
fake.EventAccumulator = Accumulator
tb = scheduler.replace(jobs[0], output_dir="work_dirs/tensorboard-fixture")
(root/tb.output_dir).mkdir(parents=True)
(root/tb.output_dir/"events.out.tfevents.fixture").write_bytes(b"")
with patch.dict(sys.modules, {"tensorboard": types.ModuleType("tensorboard"),
        "tensorboard.backend": types.ModuleType("tensorboard.backend"),
        "tensorboard.backend.event_processing": types.ModuleType("tensorboard.backend.event_processing"),
        "tensorboard.backend.event_processing.event_accumulator": fake}), \
     patch.object(scheduler, "tensorboard_conversion_available", lambda: True), \
     patch.dict(os.environ, {"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": json.dumps(identity)}):
    assert scheduler.collect_tensorboard_metrics(tb)["ok"]
rows = list(scheduler.csv.DictReader((root/tb.output_dir/"tensorboard_scalars.csv").open(encoding="utf-8")))
assert rows[0]["global_job_id"] == identity["globalJobId"]
assert rows[0]["run_id"] == identity["workflowId"] and rows[0]["command_id"] == identity["commandId"]
assert "attempt_id" not in rows[0]
try:
    scheduler.jobs_for_args(loaded, SimpleNamespace(debug_mode=True))
except ValueError as exc:
    assert "DRAFT_EXECUTION_RETIRED" in str(exc)
else:
    raise AssertionError("debug isolation created a new job")
with patch.dict(os.environ, {"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": json.dumps(identity)}):
    context = scheduler.wrapper_context(jobs[0], root / "nonexistent-fixture.yaml",
        SimpleNamespace(worker_id="worker", gpu_ids="", mode="train_test", plan=plan_file), "test")
assert context["global_job_id"] == identity["globalJobId"] and context["command_id"] == identity["commandId"]
writer = extract_runtime_functions(sys.argv[1], ["summary_row", "capture_console_metrics", "write_metrics_summary"])
normalized = writer.summary_row({"metric": "AUC", "value": 0.91}, "AUC", 0.91, context)
assert "attempt_id" not in normalized and normalized["run_id"] == identity["workflowId"]
legacy = writer.summary_row({"attempt_id": "old-1"}, "AUC", 0.91, {})
assert legacy["attempt_id"] == "old-1"
captured = writer.capture_console_metrics("AUC: 0.91", context)
assert captured and "attempt_id" not in captured[0]
writer.write_metrics_summary(root / "adapter_summary_fixture.csv", captured)
header = (root / "adapter_summary_fixture.csv").read_text(encoding="utf-8").splitlines()[0]
assert "attempt_id" not in header and "global_job_id" in header and "command_id" in header
local_plan = copy.deepcopy(plan)
local_plan["naming"]["sweep_dir"] = "work_dirs/local-formal"
local_plan["paper"]["result_csv"] = "tmp/result/local-formal/{case}/seed{seed}/metrics.csv"
local_file = "experiments/plans/local.yaml"
(root/local_file).write_text(scheduler.yaml.safe_dump(local_plan), encoding="utf-8")
_, local_jobs = scheduler.build_jobs(scheduler.load_plan(local_file))
captured_identities = []
def local_writer(job, args):
    captured_identities.append(json.loads(os.environ["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"]))
    (root/job.output_dir/"fixture.txt").write_text("local fixture only", encoding="utf-8")
with patch.dict(os.environ, {}, clear=True), patch.object(scheduler, "run_job_unlocked", local_writer):
    for job in local_jobs:
        scheduler.run_job(job, SimpleNamespace(operation_id="local-workflow", mode="train"))
        assert "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY" not in os.environ
assert [row["globalJobId"] for row in captured_identities] == ["local-workflow:"+str(job.index) for job in local_jobs]
assert len({job.result_csv for job in local_jobs}) == 3
print(json.dumps({"ok": True, "fixture": str(root), "jobs": len(jobs)}))
