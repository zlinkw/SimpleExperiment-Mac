"""Exercise extracted production stop functions against an isolated real tmux server, CPU only."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows

source = Path(sys.argv[1]).read_text(encoding="utf-8")
names = {"local_stop_tmux_inventory", "stop_local_worker_task", "worker_task_tmux_location", "stop_scheduler_operation", "_execute_worker_command_unfenced",
         "retire_worker_state", "retirement_plan_file", "retired_operation_ids"}
tree = ast.parse(source)
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(functions) == len(names)
m = types.ModuleType("isolated_stop")
exec(compile(ast.Module(body=functions, type_ignores=[]), "isolated_stop", "exec"), m.__dict__)
root = tempfile.mkdtemp(prefix="simple-stop-control-")
socket = Path(root).name
events, files = [], {}

class Tmux:
    @staticmethod
    def run(args, **kwargs):
        assert args[0] == "tmux", args
        assert "kill-session" not in args and "kill-server" not in args
        result = subprocess.run(["tmux", "-L", socket] + args[1:], **kwargs)
        events.append(args[:])
        return result

def forbidden_pid_signal(*_):
    raise AssertionError("local stop must never send a PID signal")
m.os, m.re, m.subprocess = types.SimpleNamespace(path=os.path, environ=os.environ, kill=forbidden_pid_signal), re, Tmux
m.WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
m.SCHEMA_VERSION = 1
m.path_for = lambda _, name: name
m.read_json = lambda name, default: json.loads(json.dumps(files.get(name, default)))
def write(name, data):
    events.append(["write", name])
    files[name] = json.loads(json.dumps(data))
m.atomic_write = write
m.read_durable_plan_queue = lambda _: m.read_json("queue", {"schemaVersion":1,"jobs":[]})
m.write_durable_plan_queue = lambda _, data: write("queue", data)
m.worker_recall_tombstones_path = lambda _: "stops"
m.worker_start_claims_path = lambda _: "claims"
m.now_iso = lambda: "2026-10-14T00:00:00Z"
m.append_event = lambda *_: None
m.active_cleanup_operations = lambda _: []
m.operation_journal_index = lambda _: {"rows": []}
m.release_distributed_gpu_reservation = lambda gpu, command: events.append(["release", gpu, command])
m.action_plan_file = lambda body: body.get("planFile", "")
m.cancel_inactivity_action = lambda *_: events.append(["cancel-operation"])
m.deregister_active_run_plan = lambda *_: events.append(["deregister"])
m.terminal_action = lambda root, action, operation, op, status, message, data, **kw: {"status":status, "message":message, **data}

def window(command, name="run-probe"):
    create = Tmux.run(["tmux", "new-session", "-d", "-s", name, "-n", "task", "-P", "-F", "#{pane_id}"], capture_output=True, text=True, timeout=3)
    assert create.returncode == 0, create.stderr
    pane = create.stdout.strip()
    return m.worker_task_tmux_location(pane, name, root, {**os.environ, "SIMPLE_EXPERIMENT_JOB_COMMAND_ID":command, "SIMPLE_EXPERIMENT_JOB_PROJECT_ID":"project"})

def request(command):
    return {"action":"stop-worker-task", "stopBoundary":"local_command", "targetCommandId":command,
            "operationId":"stop-" + command, "workerId":"w", "projectId":"project", "workflowId":"workflow",
            "planRevision":"new", "codeFingerprint":"new", "collectionResultCsv":"new", "resultPathPolicy":"declared"}

def alive(window_id):
    return any(row["window"] == window_id for row in m.local_stop_tmux_inventory(root))

protected = window("other-command", "other-task")
try:
    location = window("target-command")
    original = {"commandId":"target-command", "workerId":"w", "projectId":"project", "workflowId":"workflow", "status":"running",
                "planRevision":"old", "codeFingerprint":"old", "collectionResultCsv":"old", "gpuId":"2", "pid":999999999, **location}
    files["worker_task_snapshot.json"] = {"tasks":[original, {"commandId":"other-command", "status":"running"}]}
    files["queue"] = {"jobs":[original]}
    files["claims"] = {"rows":[{"commandId":"target-command"},{"commandId":"other-command"}]}
    events.clear()
    stopped = m._execute_worker_command_unfenced(root, request("target-command"), "w")
    assert stopped["status"] == "completed", stopped
    assert not alive(location["tmuxWindowId"]) and alive(protected["tmuxWindowId"])
    assert files["worker_task_snapshot.json"]["tasks"] == [{"commandId":"other-command", "status":"running"}]
    assert files["queue"]["jobs"] == []
    assert next(row for row in files["stops"]["rows"] if row["commandId"] == "target-command")["retiredTask"]["planRevision"] == "old"
    assert stopped["stateRetired"] and "target-command" in stopped["retiredOperationIds"]
    assert files["claims"]["rows"] == [{"commandId":"other-command"}]
    assert next(i for i, row in enumerate(events) if row[:2] == ["write","stops"]) < next(i for i, row in enumerate(events) if "kill-window" in row)
    assert m._execute_worker_command_unfenced(root, request("target-command"), "w")["stoppedTasks"][0]["alreadyAbsent"]

    # Dropped task caches are not prerequisites: the command/project marker resolves the label.
    missing = window("missing-command", "missing-cache-task")
    files["worker_task_snapshot.json"] = {"tasks":[]};files["queue"] = {"jobs":[]}
    assert m._execute_worker_command_unfenced(root, request("missing-command"), "w")["status"] == "completed"
    assert not alive(missing["tmuxWindowId"])

    # A queued command is fenced without a tmux launch or scientific identity checks.
    files["queue"] = {"jobs":[{"commandId":"queued-command", "workerId":"w", "projectId":"project", "workflowId":"workflow", "status":"queued", "planRevision":"older"}]}
    assert m._execute_worker_command_unfenced(root, request("queued-command"), "w")["status"] == "completed"
    assert files["queue"]["jobs"] == []

    # Stable ownership and an actually reused window still protect unrelated work.
    foreign = {"commandId":"wrong-command", "workerId":"w", "projectId":"foreign", **protected}
    files["worker_task_snapshot.json"] = {"tasks":[foreign]}
    assert m._execute_worker_command_unfenced(root, request("wrong-command"), "w")["errorCode"] == "LOCAL_STOP_OWNER_MISMATCH"
    foreign["projectId"] = "project";files["worker_task_snapshot.json"] = {"tasks":[foreign]}
    assert m._execute_worker_command_unfenced(root, request("wrong-command"), "w")["errorCode"] == "LOCAL_STOP_WINDOW_REUSED"
    assert alive(protected["tmuxWindowId"])

    # Scheduler stop uses the same window boundary without events/PID/revision gates.
    scheduler = window("scheduler-command", "scheduler-probe")
    files["worker_task_snapshot.json"] = {"tasks":[{"commandId":"scheduler-command", "workerId":"w", "projectId":"project", "status":"running", **scheduler}]}
    response = m.stop_scheduler_operation(root, {**request("scheduler-command"), "workflowId":"", "targetOperationId":"scheduler-command", "planFile":"plans/p.yaml"})
    assert response["status"] == "completed", response
    assert response["matchedOperations"] == ["scheduler-command"] and not alive(scheduler["tmuxWindowId"])
    assert alive(protected["tmuxWindowId"])
    print(json.dumps({"ok":True, "realTmux":True, "cases":8, "pidSignals":0, "scientificProcesses":0}))
finally:
    close_fixture_tmux_windows(lambda args: Tmux.run(["tmux", *args], capture_output=True, text=True, timeout=2), socket_name=socket)
