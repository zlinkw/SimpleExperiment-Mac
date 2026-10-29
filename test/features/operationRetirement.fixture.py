"""Control-state retirement only. No processes, GPUs or research files."""
import ast
import copy
import json
import os
from pathlib import Path
import sys
import threading
import types

tree = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
names = {"retire_worker_state", "retirement_plan_file", "retired_operation_ids", "api_operation", "recent_operations",
         "append_worker_task", "write_durable_plan_queue", "write_worker_start_claim", "reserve_distributed_gpu"}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(nodes) == len(names)
m = types.ModuleType("retirement_probe")
m.os, m.copy = os, copy
m.WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
m.SCHEMA_VERSION = 1
exec(compile(ast.Module(body=nodes, type_ignores=[]), "retirement_probe", "exec"), m.__dict__)
old = {"commandId": "old", "projectId": "project", "workerId": "w", "workflowId": "workflow", "status": "failed",
       "planFile": "plans/p.yaml", "outputDir": "work/old", "planRevision": "a" * 64, "codeFingerprint": "b" * 64,
       "collectionResultCsv": "tmp/result/old.csv", "logTail": "discard-heavy-progress", "gpuId": "0", "globalJobId": "workflow:0",
       "experimentIndex": 0, "case": "case", "seed": 42, "resultPathPolicy": "declared", "planJobCount": 1,
       "enqueuedAt": "2026-10-14T00:00:00Z", "runKey": "old", "executionMode": "train_test"}
other = {"commandId": "other", "projectId": "project", "workerId": "w", "status": "running", "planFile": "plans/q.yaml"}
files = {"worker_task_snapshot.json": {"tasks": [{key:value for key,value in old.items() if key != "codeFingerprint"}, other]}, "queue": {"jobs": [old, other]},
         "claims": {"rows": [{"commandId": "old"}, {"commandId": "other"}]}, "stops": {"rows": [old]}}
raw_journal = [{"operationId": "stale-cleanup", "planFile": "plans/p.yaml", "status": "running"},
               {"operationId": "new-live", "planFile": "plans/p.yaml", "status": "running"},
               {"operationId": "same-prefix", "planFile": "plans/p-other.yaml", "status": "failed"}]
journal_bytes = json.dumps(raw_journal, sort_keys=True)
m.read_json = lambda filename, default: copy.deepcopy(files.get(filename, default))
m.atomic_write = lambda filename, data: files.__setitem__(filename, copy.deepcopy(data))
m.path_for = lambda _, filename: filename
m.worker_recall_tombstones_path = lambda _: "stops"
m.worker_start_claims_path = lambda _: "claims"
m.durable_plan_queue_path = lambda _: "queue"
m.read_durable_plan_queue = lambda _: copy.deepcopy(files["queue"])
m.read_worker_recall_tombstones = lambda _: copy.deepcopy(files.get("stops", {}).get("rows", []))
m.active_cleanup_operations = lambda _: [{"operationId": "new-live", "payload": {}}]
m.operation_journal_index = lambda _: {"rows": copy.deepcopy(raw_journal)}
m.now_iso = lambda: "2026-10-14T00:00:00Z"
m.release_distributed_gpu_reservation = lambda *_: None
payload = {"operationId": "retire-request", "projectId": "project", "workerId": "w", "workflowId": "workflow",
           "planFile": "plans/p.yaml", "targetCommandIds": ["old"]}
receipt = m.retire_worker_state("root", payload, "w")
assert receipt["stateRetired"] and receipt["retiredOperationIds"] == ["old", "retire-request", "stale-cleanup"]
assert files["worker_task_snapshot.json"]["tasks"] == [other]
assert files["queue"]["jobs"] == [other]
assert files["claims"]["rows"] == [{"commandId": "other"}]
audit = files["stops"]["rows"][0]
assert "discard-heavy-progress" not in json.dumps(audit)
assert audit["retiredTask"]["planRevision"] == "a" * 64 and audit["retiredTask"]["status"] == "failed"
assert audit["retiredTask"]["codeFingerprint"] == "b" * 64 and audit["retiredTask"]["gpuId"] == "0"
assert m.api_operation("root", "stale-cleanup")["status"] == "retired"
assert [row["operationId"] for row in m.recent_operations("root")] == ["new-live", "same-prefix"]
assert json.dumps(raw_journal, sort_keys=True) == journal_bytes
# Old asynchronous writers cannot re-create an activity row, claim or GPU lock.
m.append_worker_task("root", old)
m.write_durable_plan_queue("root", {"jobs": [old, other]})
assert files["queue"]["jobs"] == [other]
assert m.write_worker_start_claim("root", old) is False
try:
    m.reserve_distributed_gpu("root", "0", "old")
    raise AssertionError("retired GPU reservation admitted")
except RuntimeError as exc:
    assert str(exc) == "WORKER_COMMAND_RETIRED"
assert m.retire_worker_state("root", payload, "w")["stateRetired"]
assert len(files["stops"]["rows"]) == 1
# Foreign ownership and a real active task still reject before any state write.
for change, message in (({"projectId": "foreign"}, "OWNER_MISMATCH"), ({"status": "running"}, "ACTIVE_TASK")):
    files["worker_task_snapshot.json"]["tasks"] = [{**old, **change}]
    before = copy.deepcopy(files)
    try:
        m.retire_worker_state("root", payload, "w")
        raise AssertionError("unsafe state retirement accepted")
    except ValueError as exc:
        assert message in str(exc)
    assert files == before
print(json.dumps({"ok": True, "lateWriterFenced": True, "researchWrites": 0, "retiredTask": audit["retiredTask"]}))
