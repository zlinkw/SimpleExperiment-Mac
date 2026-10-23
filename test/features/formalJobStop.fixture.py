"""Real isolated tmux stop boundary; retains fixture files and never visits a Worker."""
import ast
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
repo = pathlib.Path(__file__).resolve().parents[2]
source = repo / "dist/runtime/cluster_agent.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
wanted = {"_execute_worker_command_unfenced", "worker_task_matches_stop_identity",
          "worker_task_stop_identity_mismatches", "close_worker_task_pane", "worker_task_pane_presence",
          "durable_plan_value", "durable_plan_identity", "durable_plan_public_identity",
          "cancel_durable_plan_job", "now_iso"}
body = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
        or getattr(node, "name", None) in wanted
        or isinstance(node, ast.Assign) and any(getattr(target, "id", "") in
           ("DURABLE_PLAN_IDENTITY_FIELDS", "LEGACY_WORKER_STOP_IDENTITY_FIELDS") for target in node.targets)]
ns = {"__builtins__": __builtins__}
exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), ns)
root = tempfile.mkdtemp(prefix="simple-formal-stop-")
socket = "formal-stop-probe-" + pathlib.Path(root).name
original_run = subprocess.run
calls = []

def isolated_run(args, **kwargs):
    calls.append(args)
    if args[0] == "tmux":
        args = ["/usr/bin/tmux", "-L", socket, "-f", "/dev/null", *args[1:]]
    return original_run(args, **kwargs)

ns["subprocess"].run = isolated_run
ns["os"].kill = lambda *args: (_ for _ in ()).throw(AssertionError("must only close the exact pane"))
ns["WORKER_TASK_SNAPSHOT_LOCK"] = threading.RLock()
ns["SCHEMA_VERSION"] = 1
ns["append_event"] = lambda *args: None
ns["path_for"] = lambda root, name: name
store = {"tasks": []}
queue = {"schemaVersion": 1, "jobs": []}
ns["read_json"] = lambda *args: store
ns["read_durable_plan_queue"] = lambda *args: copy.deepcopy(queue)
ns["write_durable_plan_queue"] = lambda root, data: queue.update(copy.deepcopy(data))
ns["release_distributed_gpu_reservation"] = lambda *args: None

def remember(root, task):
    store["tasks"] = [row for row in store["tasks"] if row["commandId"] != task["commandId"]] + [task]

ns["append_worker_task"] = remember
ns["current_worker_task"] = lambda root, task: next(row for row in store["tasks"] if row["commandId"] == task["commandId"])
execute = ns["_execute_worker_command_unfenced"]

def tmux(*args):
    result = isolated_run(["tmux", *args], capture_output=True, text=True, timeout=3, cwd=root)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()

def stop_for(task):
    return {"action": "stop-worker-task", "commandId": "stop-" + task["commandId"],
            "targetCommandId": task["commandId"],
            **{key: task[key] for key in (*ns["DURABLE_PLAN_IDENTITY_FIELDS"], "gpuId", "planJobCount",
                                        "resultPathPolicy", "globalJobId", "collectionResultCsv")
               if key not in ("commandId", "attempt")}}

class FormalTask(dict):
    def get(self, key, *args):
        assert key != "attempt", "formal stop must never read or manufacture an attempt version"
        return super().get(key, *args)

reports = []
try:
    tmux("new-session", "-d", "-s", "zlk-gpu-0", "sleep 60")
    unrelated = tmux("display-message", "-p", "-t", "zlk-gpu-0:0", "#{pane_id}")
    for index, status in enumerate(("failed", "running", "completed")):
        pane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "zlk-gpu-0", "sleep 60")
        task = FormalTask({"projectId": "project", "workflowId": "old-workflow", "planFile": "experiments/plans/quality_composition/late_fusion.yaml",
                "planRevision": "original-revision", "codeFingerprint": "original-code", "experimentIndex": index,
                "case": "original-case-" + str(index), "seed": 42, "outputDir": "work_dirs/direct_jobs/" + str(index),
                "runKey": "command-" + str(index), "commandId": "command-" + str(index), "workerId": "worker",
                "gpuId": "0", "planJobCount": 3, "resultPathPolicy": "declared", "globalJobId": "old-workflow:" + str(index),
                "collectionResultCsv": "tmp/result/direct_jobs/" + str(index) + "/metrics.csv",
                "tmuxPane": pane, "tmuxSession": "zlk-gpu-0", "pid": pane, "status": status})
        log = pathlib.Path(root) / (task["commandId"] + ".failed.log")
        log.write_text("original failure\n", encoding="utf-8")
        before = log.read_bytes()
        store["tasks"] = [task]
        request = stop_for(task)
        for field in ("projectId", "workflowId", "planRevision", "codeFingerprint", "experimentIndex", "case", "seed",
                      "outputDir", "runKey", "workerId", "gpuId", "planJobCount", "resultPathPolicy", "globalJobId", "collectionResultCsv"):
            for missing in (False, True):
                wrong = dict(request)
                if missing:
                    wrong.pop(field)
                else:
                    wrong[field] = 999 if field in ("seed", "experimentIndex", "planJobCount") else "another-job"
                call_count = len(calls)
                rejected = execute(root, wrong, "worker")
                assert rejected["status"] == "failed" and len(calls) == call_count, (field, rejected)
                assert field in rejected.get("identityMismatchFields", []), (field, rejected)
        for retired_value in (0, 1):
            for recall in (False, True):
                wrong = {**request, "attempt": retired_value, "requeueRequested": recall}
                rejected = execute(root, wrong, "worker")
                assert rejected["errorCode"] == "FORMAL_ATTEMPT_RETIRED" and "attempt" in rejected["identityMismatchFields"], rejected
        result = execute(root, request, "worker")
        assert result["status"] == "completed", result
        receipt = result["stoppedTasks"][0]
        assert receipt["paneClosed"] is True and "attempt" not in receipt, receipt
        assert receipt["globalJobId"] == task["globalJobId"] and receipt["resultPathPolicy"] == "declared", receipt
        # Fresh tmux absence and an idempotent second stop; other job and log bytes stay.
        assert unrelated in tmux("list-panes", "-a", "-F", "#{pane_id}") and pane not in tmux("list-panes", "-a", "-F", "#{pane_id}")
        again = execute(root, request, "worker")
        assert again["status"] == "completed" and again["stoppedTasks"][0]["paneAlreadyMissing"] is True, again
        assert log.read_bytes() == before
        reports.append({"task": store["tasks"][0], "request": request, "result": result})
    queued = {**task, "commandId": "queued-command", "runKey": "queued-command", "status": "queued"}
    for key in ("pid", "tmuxPane", "tmuxSession"):
        queued.pop(key)
    queue["jobs"] = [queued]
    store["tasks"] = []
    wrong = {**stop_for(queued), "globalJobId": "another-workflow:0"}
    rejected = execute(root, wrong, "worker")
    assert rejected["errorCode"] == "WORKER_TASK_IDENTITY_MISMATCH" and "globalJobId" in rejected["identityMismatchFields"], rejected
    assert queue["jobs"][0]["status"] == "queued" and store["tasks"] == []
    cancelled = execute(root, stop_for(queued), "worker")
    assert cancelled["status"] == "completed", cancelled
    proof = cancelled["stoppedTasks"][0]
    assert proof["gpuId"] == "0" and proof["resultPathPolicy"] == "declared" and "attempt" not in proof, proof
    assert queue["jobs"][0]["status"] == "cancelled" and store["tasks"][0]["status"] == "cancelled"
    reports.append({"task": store["tasks"][0], "request": stop_for(queued), "result": cancelled})
    print(json.dumps({"ok": True, "reports": reports}, ensure_ascii=False))
finally:
    close_fixture_tmux_windows(lambda args: isolated_run(["tmux", *args], capture_output=True, text=True, timeout=2, cwd=root), socket_name=socket)
