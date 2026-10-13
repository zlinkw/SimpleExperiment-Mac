"""Replay extracted production messages without launching a runtime entry point or GPU task."""
import copy
import io
import json
import os
import pathlib
import sys
import tempfile
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["formal_job_preflight_report", "formal_source_fingerprint"])
agent = extract_runtime_functions(str(runtime / "cluster_agent.py"), ["accept_durable_plan_job", "handle_action", "drain_durable_plan_queue_once"])
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-preflight-rejection-")).resolve()
os.chdir(root)
(root / "experiments/plans").mkdir(parents=True)
plan_file = "experiments/plans/formal.yaml"
plan = {"mode": "train_test", "seeds": [42, 43], "base_config": {"runtime": {}, "test": {}},
        "naming": {"sweep_dir": "work_dirs/formal", "job_name": "{case}_seed{seed}"},
        "paper": {"result_csv": "tmp/result/formal/{case}/seed{seed}/metrics.csv"},
        "runner": {"train_command": "never-train", "test_command": "never-test {result_csv}"}, "cases": [{"case": "case"}]}
(root / plan_file).write_text(scheduler.yaml.safe_dump(plan), encoding="utf-8")
loaded = scheduler.load_plan(plan_file)
_, jobs = scheduler.build_jobs(loaded)
command = {"schemaVersion": 1, "action": "start-worker-task", "opId": "formal-command", "commandId": "formal-command",
    "runKey": "formal-command", "workflowId": "formal-flow", "globalJobId": "formal-flow:0", "projectId": sys.argv[1],
    "planFile": plan_file, "planRevision": loaded["_revision"], "codeFingerprint": scheduler.formal_source_fingerprint(root),
    "workerId": "worker", "experimentIndex": 0, "case": "case", "seed": 42, "planJobCount": 2,
    "enqueuedAt": agent.now_iso(), "mode": "train_test", "executionMode": "train_test", "durablePlanQueue": True,
    "requireIdleGpu": True, "gpuId": "0", "outputDir": jobs[0].output_dir, "collectionResultCsv": jobs[0].result_csv,
    "resultPathPolicy": "declared"}
queue = {"schemaVersion": 1, "jobs": []}
events = []
preflight_calls = []

def read_queue(_):
    value = copy.deepcopy(queue)
    for row in value["jobs"]:
        if row.get("resultPathPolicy") == "declared":
            row["attempt"] = 0
    return value

def persist(_, value):
    queue.clear()
    queue.update(copy.deepcopy(value))

def scheduler_rpc(argv, **kw):
    assert kw["progress_stream"] == "stderr" and kw["cwd"] == str(root)
    args = SimpleNamespace(plan=plan_file, only_index=int(argv[argv.index("--only-index") + 1]),
        mode=argv[argv.index("--mode") + 1], plan_revision=argv[argv.index("--plan-revision") + 1],
        output_dir_override=argv[argv.index("--output-dir-override") + 1], default_result_csv_dir="experiments/results")
    preflight_calls.append(args.only_index)
    with patch.dict(os.environ, kw["env"]):
        try:
            report = scheduler.formal_job_preflight_report(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")
        except ValueError as exc:
            return SimpleNamespace(returncode=1, stdout="", stderr="Traceback (fixture)\nValueError: " + str(exc))

def forbidden(*a, **kw):
    raise AssertionError("No GPU probe, tmux, process, or signal is allowed for rejection")

with patch.object(agent, "cluster_scheduler_path", lambda _: str(runtime / "cluster_scheduler.py")), \
     patch.object(agent, "subprocess_inactivity_run", scheduler_rpc), \
     patch.object(agent, "simple_runtime_env", lambda env: env), \
     patch.object(agent, "simple_runtime_python", lambda _: sys.executable), \
     patch.object(agent, "read_durable_plan_queue", read_queue), \
     patch.object(agent, "durable_plan_queue_path", lambda _: "fixture-queue.json"), \
     patch.object(agent, "atomic_write", persist), \
     patch.object(agent, "recalled_worker_command", lambda *a: None), \
     patch.object(agent, "collect_local_gpu", forbidden), \
     patch.object(agent, "signal_durable_plan_queue_processor", forbidden), \
     patch.object(agent, "verified_durable_execution_mode", lambda *a: "train_test"), \
     patch.object(agent, "append_event", lambda _, event: events.append(event)):
    output = root / command["outputDir"]
    output.mkdir(parents=True)
    checkpoint = output / "existing_checkpoint.pt"
    checkpoint.write_bytes(b"protected fixture checkpoint")
    receipt = agent.handle_action(str(root), "start-worker-task", command, command["commandId"], command["commandId"])
    assert receipt["status"] == "failed" and receipt["admissionRejected"] is True and receipt["durableAccepted"] is False
    assert receipt["neverStarted"] and receipt["neverStartedEvidence"] == "formal_preflight_rejected"
    assert receipt["errorCode"] == "FORMAL_JOB_CONFLICT" and command["outputDir"] in receipt["error"]
    assert command["collectionResultCsv"] in receipt["error"] and "Traceback" not in receipt["message"]
    evidence = receipt["formalConflictEvidence"]
    assert evidence["workerId"] == "worker" and evidence["projectRoot"] == str(root)
    assert evidence["outputDir"] == str(output) and evidence["ownerExists"] is False
    assert "checkpoint" in evidence["categories"] and evidence["hashesVerified"] is False
    try:
        agent.verified_formal_job_command(str(root), {key: value for key, value in command.items() if key != "globalJobId"})
    except ValueError as exc:
        assert "missing=globalJobId" in str(exc)
    else:
        raise AssertionError("Agent fabricated a missing original globalJobId")
    assert "attempt" not in receipt and "attempt" not in queue["jobs"][0]
    assert events[-1]["type"] == "operation_failed" and events[-1]["payload"]["reason"] == "formal_preflight_rejected"
    again = agent.accept_durable_plan_job(str(root), command, "worker")
    assert again["finishedAt"] == receipt["finishedAt"] and len(preflight_calls) == 1
    assert checkpoint.read_bytes() == b"protected fixture checkpoint"

    # A lost durable row with prior execution evidence must remain uncertain.
    saved = copy.deepcopy(queue)
    queue["jobs"] = []
    with patch.object(agent, "read_json", lambda *a: {"tasks": [{"commandId": command["commandId"]}]}):
        try:
            agent.accept_durable_plan_job(str(root), command, "worker")
        except ValueError as exc:
            assert "RECEIPT_UNCERTAIN" in str(exc)
        else:
            raise AssertionError("execution snapshot fabricated a never-started receipt")
    with patch.object(agent, "read_json", lambda path, *a: {"commandId": command["commandId"]} if "formal_job_owner.json" in str(path) else {}):
        try:
            agent.accept_durable_plan_job(str(root), command, "worker")
        except ValueError as exc:
            assert "RECEIPT_UNCERTAIN" in str(exc)
        else:
            raise AssertionError("formal owner fabricated a never-started receipt")
    assert not queue["jobs"]
    persist(None, saved)

    # Already accepted jobs also terminate on a new preflight conflict instead of code-wait forever.
    pending = {**command, "commandId": "queued-command", "runKey": "queued-command", "globalJobId": "formal-flow:1",
        "experimentIndex": 1, "seed": 43, "gpuId": "1", "outputDir": jobs[1].output_dir,
        "collectionResultCsv": jobs[1].result_csv, "status": "queued", "acceptedAt": agent.now_iso()}
    queue["jobs"].append(pending)
    agent.DISTRIBUTED_GPU_RESERVATIONS.update({"0": "another-command", "1": "queued-command"})
    changed = root / pending["outputDir"]
    changed.mkdir(parents=True)
    (changed / "old.log").write_text("retained", encoding="utf-8")
    with patch.object(agent, "reconcile_worker_task_exit_codes", lambda *a: None), \
         patch.object(agent, "sync_durable_plan_task_rows", read_queue), \
         patch.object(agent, "resolve_durable_code_sync_proof", lambda *a: {}):
        terminal = agent.drain_durable_plan_queue_once(str(root), "worker", gpu_probe=forbidden, execute=forbidden)
        assert len(terminal) == 1 and terminal[0]["status"] == "failed" and terminal[0]["durableAccepted"] is True
        assert not agent.drain_durable_plan_queue_once(str(root), "worker", gpu_probe=forbidden, execute=forbidden)
    assert "1" not in agent.DISTRIBUTED_GPU_RESERVATIONS and agent.DISTRIBUTED_GPU_RESERVATIONS["0"] == "another-command"
    assert (changed / "old.log").read_text(encoding="utf-8") == "retained"

print(json.dumps({"ok": True, "receipt": receipt, "calls": len(preflight_calls)}, ensure_ascii=False))
