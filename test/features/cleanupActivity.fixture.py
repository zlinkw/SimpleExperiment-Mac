"""Extract live activity boundaries only; never start Agent/Scheduler."""
import ast
import json
import os
import re
from pathlib import Path
import sys
import threading
import types

tree = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
names = {"active_cleanup_operations", "tracked_cleanup_action", "api_worker_tasks"}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(functions) == len(names)
m = types.ModuleType("activity_probe")
m.os, m.re, m.INACTIVITY_ACTIONS_LOCK = os, re, threading.Lock()
m.INACTIVITY_ACTIONS, m.LIVE_CLEANUP_ACTIONS = {}, {}
exec(compile(ast.Module(body=functions, type_ignores=[]), "activity_probe", "exec"), m.__dict__)
root = os.path.abspath("fixture-project")
def entry(action, op, **extra):
    return {"action": action, "operationId": op, "payload": {"outputDir": "work/job", "token": "must-not-leak"}, **extra}
m.INACTIVITY_ACTIONS[(root, "completed")] = entry("archive-worker-artifacts", "completed", result={"status": "failed"})
m.INACTIVITY_ACTIONS[(root, "live")] = entry("archive-worker-artifacts", "live")
m.INACTIVITY_ACTIONS[(root, "readonly")] = entry("validate-plan", "readonly")
m.INACTIVITY_ACTIONS[(root + "-other", "foreign")] = entry("archive-worker-artifacts", "foreign")
assert [row["operationId"] for row in m.active_cleanup_operations(root)] == ["live"]
assert "must-not-leak" not in json.dumps(m.active_cleanup_operations(root))
m.reconcile_worker_task_exit_codes = lambda _: None
m.sync_durable_plan_task_rows = lambda _: None
m.path_for = lambda _, filename: filename
m.read_durable_plan_queue = lambda _: {"jobs": []}
m.now_iso = lambda: "2026-10-14T00:00:00Z"
m.formal_job_path_capable = lambda _: True
m.SCHEMA_VERSION = 1
m.read_worker_recall_tombstones = lambda _: []
for stored in ({"tasks": []}, None):
    m.read_runtime_json_cached = lambda *_: stored
    response = m.api_worker_tasks(root)
    assert response["tasks"] == []
    assert [row["operationId"] for row in response["activeOperations"]] == ["live"]
m.read_worker_recall_tombstones = lambda _: [{"commandId":"old", "retiredTask":{"commandId":"old", "status":"failed", "readOnly":True}},
                                            {"commandId":"unrequested", "retiredTask":{"commandId":"unrequested"}}]
assert m.api_worker_tasks(root)["retiredTasks"] == []
assert [row["commandId"] for row in m.api_worker_tasks(root, ["old"])["retiredTasks"]] == ["old"]
def handle(*args):
    assert {row["operationId"] for row in m.active_cleanup_operations(root)} == {"live", "sync"}
    return {"ok": True}
m.handle_action = handle
assert m.tracked_cleanup_action(root, "archive-worker-artifacts", {}, "sync", "sync") == {"ok": True}
assert not m.LIVE_CLEANUP_ACTIONS
def fail(*args):
    raise RuntimeError("probe failure")
m.handle_action = fail
try:
    m.tracked_cleanup_action(root, "archive-worker-artifacts", {}, "sync", "sync")
    raise AssertionError("failure swallowed")
except RuntimeError:
    pass
assert not m.LIVE_CLEANUP_ACTIONS
# Restarted Agent has no execution, even when the journal still says running.
m.INACTIVITY_ACTIONS.clear()
assert m.active_cleanup_operations(root) == []
print(json.dumps({"ok": True, "liveRegistry": True, "historyWrites": 0}))
