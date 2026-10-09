"""Isolated functions with in-memory evidence; no runtime entry point or research process."""
import copy
import contextlib
import hashlib
import io
import json
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
agent = extract_runtime_functions(str(runtime / "cluster_agent.py"), ["verified_durable_execution_mode", "recover_train_only_completion", "_execute_worker_command_unfenced", "drain_durable_plan_queue_once"])
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["plan_execution_mode"])
resolved = []
for mode in ("train", "test", "train_test"):
    raw = ("mode: " + mode + "\r\n").encode("utf-8")
    fake_scheduler = SimpleNamespace(load_plan=lambda _: {"mode": mode}, plan_execution_mode=scheduler.plan_execution_mode)
    with patch.object(agent, "safe_project_path", lambda *args: "virtual"), \
         patch.object(agent, "scalar_scheduler_module", lambda: fake_scheduler), \
         patch.object(pathlib.Path, "read_bytes", lambda _: raw):
        legacy = {"planFile": "plan.yaml", "planRevision": hashlib.sha256(raw).hexdigest(), "mode": "train_test"}
        assert agent.verified_durable_execution_mode("virtual", legacy) == mode
        assert agent.verified_durable_execution_mode("virtual", {**legacy, "mode": mode, "executionMode": mode}) == mode
        for bad in ({**legacy, "planRevision": "changed"}, {**legacy, "executionMode": "predict"},
                    {**legacy, "executionMode": "test" if mode == "train" else "train"}):
            try:
                agent.verified_durable_execution_mode("virtual", bad)
            except ValueError:
                pass
            else:
                raise AssertionError("unsafe Worker mode accepted")
        resolved.append(mode)
        launched, saved = [], []
        command = dict(action="start-worker-task", commandId="launch", operationId="launch", planFile="plan.yaml", projectId="project",
                       planRevision=legacy["planRevision"], codeFingerprint="code", experimentIndex=0, attempt=1,
                       case="case", seed=42, outputDir="work/job/attempts/run", mode=mode, executionMode=mode,
                       condaEnv="env", options={"distributedResults": True})
        ledger = {"jobs": []}
        durable_command = {**command, "workerId": "worker", "workflowId": "run", "runKey": "launch",
                           "planJobCount": 1, "enqueuedAt": "2026-10-09T00:00:00Z"}
        with patch.object(agent, "read_durable_plan_queue", lambda _: ledger), \
             patch.object(agent, "write_durable_plan_queue", lambda *args: None), \
             patch.object(agent, "recalled_worker_command", lambda *args: None), \
             patch.object(agent, "signal_durable_plan_queue_processor", lambda *args: None), \
             patch.object(agent, "append_event", lambda *args: None):
            assert agent.accept_durable_plan_job("virtual", durable_command, "worker")["durableAccepted"]
            assert ledger["jobs"][0]["mode"] == mode and ledger["jobs"][0]["executionMode"] == mode
            assert agent.accept_durable_plan_job("virtual", durable_command, "worker")["durableAccepted"]
            assert len(ledger["jobs"]) == 1
            try:
                agent.accept_durable_plan_job("virtual", {**durable_command, "executionMode": "test" if mode == "train" else "train"}, "worker")
            except ValueError: pass
            else: raise AssertionError("existing durable command changed mode")
        with contextlib.ExitStack() as scope:
            replacements = {
                "agent_install_dir": lambda _: "virtual", "require_scheduler_dependencies": lambda *args: None,
                "simple_runtime_python": lambda _: "virtual-python",
                "reserve_distributed_gpu": lambda *args: None, "release_distributed_gpu_reservation": lambda *args: None,
                "tmux_available": lambda: True, "start_job_in_gpu_pane": lambda session, args, *rest: launched.append(args) or "%virtual",
                "append_worker_task": lambda _, task: saved.append(task), "append_event": lambda *args: None,
            }
            for key, replacement in replacements.items(): scope.enter_context(patch.object(agent, key, replacement))
            scope.enter_context(patch.object(agent.os, "makedirs", lambda *args, **kwargs: None))
            scope.enter_context(patch.object(agent.os.path, "isfile", lambda _: True))
            scope.enter_context(patch.object(agent.threading, "Thread", lambda *args, **kwargs: SimpleNamespace(start=lambda: None)))
            result = agent._execute_worker_command_unfenced("virtual", command, "worker")
            assert result["status"] == "running"
            assert launched[0][launched[0].index("--mode") + 1] == mode
            assert saved[0]["mode"] == mode and saved[0]["executionMode"] == mode
        # Restore a legacy unstarted row; an owned running row must never be restarted.
        queued = {**command, "status": "queued", "workerId": "worker", "mode": "train_test"}
        queued.pop("executionMode")
        active = {**queued, "commandId": "active", "status": "running"}
        data = {"jobs": [queued, active]}
        dispatched = []
        with contextlib.ExitStack() as scope:
            replacements = {
                "reconcile_worker_task_exit_codes": lambda *args: None,
                "sync_durable_plan_task_rows": lambda _: data,
                "read_durable_plan_queue": lambda _: data,
                "write_durable_plan_queue": lambda *args: None,
                "resolve_durable_code_sync_proof": lambda *args: {},
                "read_json": lambda *args: {"tasks": []},
                "_durable_gpu_busy_reason": lambda *args, **kwargs: "",
                "append_event": lambda *args: None,
            }
            for key, replacement in replacements.items(): scope.enter_context(patch.object(agent, key, replacement))
            scope.enter_context(patch.dict(agent.DISTRIBUTED_GPU_RESERVATIONS, {}, clear=True))
            agent.drain_durable_plan_queue_once("virtual", "worker", lambda: ([{"index": "0"}], ""),
                lambda _, item, worker: dispatched.append(item) or {"status": "running"})
            assert len(dispatched) == 1 and dispatched[0]["mode"] == mode and dispatched[0]["options"]["mode"] == mode
            assert active["mode"] == "train_test" and active["status"] == "running"

output = "work/job/attempts/run"
row = dict(projectId="project", workflowId="run", planFile="plans/train.yaml", planRevision="revision", codeFingerprint="code",
           experimentIndex=0, case="candidate", seed=42, attempt=1, outputDir=output, runKey="command", commandId="command",
           workerId="worker", status="failed", mode="train_test", stage="train_test", finishedAt="done", exitCode=1,
           error="ValueError: Validation-only tuning cannot access test patients; lock parameters in a separate PLAN first")
manifest = dict(selection_only=True, test_accessed=False, selection_metric="roc_auc", selection_candidate="c00", selection_dataset="pad",
                checkpoint_path=output + "/best_model.pth", checkpoint_manifest=output + "/checkpoint_manifest.json",
                config_snapshot=output + "/config_snapshot.yaml", metrics_summary=output + "/metrics_summary.csv")
final_config = {"seed": 42, "train": {"selection_only": True}, "paper": {"case": "candidate"},
                "tuning": {"candidate": "c00"}, "data": {"dataset": "pad"}}
files = {output + "/config.yaml": json.dumps(final_config).encode(), output + "/config_snapshot.yaml": b"# snapshot comment\n" + json.dumps(final_config).encode(),
         output + "/best_model.pth": b"checkpoint", output + "/checkpoint_manifest.json": b"checkpoint-index",
         output + "/artifact_manifest.json": b"manifest",
         output + "/stderr.log": b"Traceback (most recent call last):\nValueError: Validation-only tuning cannot access test patients; lock parameters in a separate PLAN first\n",
         output + "/metrics_summary.csv": b"split,eval_protocol,source,seed,case,metric,value\nval,p100_low,p100_validation_checkpoint,42,candidate,roc_auc,0.8\n"}

def recovery(change=None, confirm=False):
    data = {"jobs": [copy.deepcopy(row)]}
    snapshot = {"tasks": [copy.deepcopy(row)]}
    local_files, local_manifest = dict(files), dict(manifest)
    if change:
        change(data["jobs"][0], snapshot["tasks"][0], local_files, local_manifest)
    before = copy.deepcopy(local_files)
    writes = []
    agent.WORKER_TASK_FAILURE_CACHE.clear()
    def read_json(filename, default):
        if filename == "snapshot": return snapshot
        if filename.endswith("artifact_manifest.json"): return local_manifest
        if filename.endswith("checkpoint_manifest.json"):
            return {"checkpoint_path": manifest["checkpoint_path"], "size_bytes": len(files[output + "/best_model.pth"])}
        return default
    def append(_, task):
        snapshot["tasks"] = [task]
        writes.append("snapshot")
    def stat(filename, *args, **kwargs):
        if filename not in local_files:
            raise FileNotFoundError(filename)
        return SimpleNamespace(st_size=len(local_files[filename]), st_mtime_ns=1)
    def open_file(filename, mode="r", **kwargs):
        return io.BytesIO(local_files[filename]) if "b" in mode else io.StringIO(local_files[filename].decode("utf-8"))
    with patch.object(agent, "read_durable_plan_queue", lambda _: data), \
         patch.object(agent, "write_durable_plan_queue", lambda *args: writes.append("queue")), \
         patch.object(agent, "append_worker_task", append), \
         patch.object(agent, "path_for", lambda *args: "snapshot"), \
         patch.object(agent, "read_json", read_json), \
         patch.object(agent, "verified_durable_execution_mode", lambda *args: "train"), \
         patch.object(agent, "scalar_scheduler_module", lambda: SimpleNamespace(load_config=lambda name: json.loads(local_files[name].decode().splitlines()[-1]))), \
         patch.object(agent, "safe_project_path", lambda _, relative: relative), \
         patch.object(agent, "sha256_file", lambda filename: hashlib.sha256(local_files[filename]).hexdigest()), \
         patch.object(agent.os.path, "isfile", lambda filename: filename in local_files), \
         patch.object(agent.os.path, "islink", lambda _: False), \
         patch.object(agent.os.path, "getsize", lambda filename: len(local_files[filename])), \
         patch.object(agent.os.path, "getmtime", lambda filename: 0 if filename.endswith(".pth") else 1), \
         patch.object(agent.os, "stat", stat), \
         patch("builtins.open", open_file):
        request = {**row, "commandId": "recovery-command", "targetCommandId": "command"}
        if not snapshot["tasks"][0].get("error") and not data["jobs"][0].get("error"):
            agent.WORKER_TASK_FAILURE_CACHE[(output + "/stderr.log", 1, len(local_files.get(output + "/stderr.log", b"")))] = "RuntimeError: stale cached failure"
        preview = agent.recover_train_only_completion("virtual", request, "worker")
        assert not writes and preview["preview"] and not preview["recovered"]
        if not snapshot["tasks"][0].get("error") and not data["jobs"][0].get("error"):
            assert preview["trainingRecovery"]["sha256"][output + "/stderr.log"] == hashlib.sha256(local_files[output + "/stderr.log"]).hexdigest()
        if confirm:
            if output + "/stderr.log" in preview["trainingRecovery"]["sha256"]:
                original_stderr = local_files[output + "/stderr.log"]
                local_files[output + "/stderr.log"] += b"\n"
                try:
                    agent.recover_train_only_completion("virtual", {**request, "confirm": True,
                        "evidenceSignature": preview["evidenceSignature"]}, "worker")
                except ValueError: pass
                else: raise AssertionError("changed failure evidence accepted after review")
                assert not writes
                local_files[output + "/stderr.log"] = original_stderr
            try:
                agent.recover_train_only_completion("virtual", {**request, "confirm": True, "evidenceSignature": "stale"}, "worker")
            except ValueError: pass
            else: raise AssertionError("stale review accepted")
            recovered = agent.recover_train_only_completion("virtual", {**request, "confirm": True,
                "evidenceSignature": preview["evidenceSignature"]}, "worker")
            assert recovered["recovered"] and data["jobs"][0]["status"] == "completed"
            assert data["jobs"][0]["originalExecution"]["exitCode"] == 1
            assert data["jobs"][0]["originalExecution"]["mode"] == "train_test"
            assert agent.recover_train_only_completion("virtual", request, "worker")["recovered"]
        assert local_files == before, "recovery must never modify result/config/checkpoint bytes"

recovery(confirm=True)
def clear_errors(r, t, f, m):
    r.pop("error", None)
    t.pop("error", None)

# Exit-code reconciliation stores no error string; the public task endpoint enriches it from this attempt's stderr.
recovery(clear_errors, confirm=True)
rejected = 0
for change in [lambda r,t,f,m: f.pop(output + "/best_model.pth"),
               lambda r,t,f,m: f.update({output + "/config_snapshot.yaml": json.dumps({**final_config, "seed": 43}).encode()}),
               lambda r,t,f,m: f.update({output + "/metrics_summary.csv": files[output + "/metrics_summary.csv"].replace(b"p100_validation_checkpoint", b"test.py")}),
               lambda r,t,f,m: f.update({output + "/metrics_summary.csv": files[output + "/metrics_summary.csv"].replace(b"val,", b"test,")}),
               lambda r,t,f,m: f.update({output + "/metrics_summary.csv": files[output + "/metrics_summary.csv"].replace(b"candidate,", b"other,")}),
               lambda r,t,f,m: f.update({output + "/metrics_summary.csv": files[output + "/metrics_summary.csv"].replace(b",42,", b",44,")}),
               lambda r,t,f,m: f.update({output + "/metrics_summary.csv": files[output + "/metrics_summary.csv"].replace(b"0.8", b"nan")}),
               lambda r,t,f,m: m.update(test_accessed=True), lambda r,t,f,m: r.update(status="running"),
               lambda r,t,f,m: (clear_errors(r,t,f,m), f.pop(output + "/stderr.log")),
               lambda r,t,f,m: (clear_errors(r,t,f,m), f.update({output + "/stderr.log": b"ValueError: project configuration is broken\n"})),
               lambda r,t,f,m: t.update(error="RuntimeError: CUDA out of memory"),
               lambda r,t,f,m: r.update(stopReason="manual_stop"),
               lambda r,t,f,m: t.update(workerId="foreign-worker")]:
    try: recovery(change)
    except ValueError: rejected += 1
    else: raise AssertionError("unsafe training recovery accepted")
print(json.dumps({"modes": resolved, "recovery": "verified", "rejected": rejected}))
