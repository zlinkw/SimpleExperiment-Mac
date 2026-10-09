"""Test only extracted memory pruning functions, without importing Agent entry points."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(
    str(pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_agent.py"),
    ["prune_runtime_memory_state", "prune_scheduler_dependency_cache"],
)

agent.UPLOADS.clear()
for i in range(agent.MAX_UPLOAD_RECORDS + 30):
    agent.UPLOADS[f"upload-{i}"] = {"status": "completed", "transferredBytes": i}
agent.UPLOADS["running-old"] = {"status": "running", "transferredBytes": 0}

agent.WORKER_COMMAND_RESULTS.clear()
for i in range(agent.MAX_WORKER_COMMAND_RESULT_RECORDS + 30):
    agent.WORKER_COMMAND_RESULTS[f"cmd-{i}"] = {"status": "completed", "seq": i}

agent.WORKER_ACTION_LAST_AT.clear()
agent.WORKER_ACTION_INFLIGHT.clear()
for i in range(agent.MAX_WORKER_ACTION_KEY_RECORDS + 30):
    agent.WORKER_ACTION_LAST_AT[f"worker-{i}"] = i
agent.WORKER_ACTION_INFLIGHT["worker-0"] = 1

agent.prune_runtime_memory_state()

agent.SCHEDULER_DEPENDENCY_CACHE.clear()
cache_now = 2000
for i in range(agent.MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS + 30):
    agent.SCHEDULER_DEPENDENCY_CACHE[f"scheduler-{i}"] = {"_checkedAtEpoch": cache_now - i}
agent.SCHEDULER_DEPENDENCY_CACHE["active-old"] = {"_checkedAtEpoch": cache_now - agent.SCHEDULER_DEPENDENCY_CACHE_TTL_SECONDS - 10}
agent.prune_scheduler_dependency_cache(cache_now, "active-old")

print(json.dumps({
    "uploads": len(agent.UPLOADS),
    "uploadOld": "upload-0" in agent.UPLOADS,
    "uploadNew": f"upload-{agent.MAX_UPLOAD_RECORDS + 29}" in agent.UPLOADS,
    "uploadRunning": "running-old" in agent.UPLOADS,
    "results": len(agent.WORKER_COMMAND_RESULTS),
    "resultOld": "cmd-0" in agent.WORKER_COMMAND_RESULTS,
    "resultNew": f"cmd-{agent.MAX_WORKER_COMMAND_RESULT_RECORDS + 29}" in agent.WORKER_COMMAND_RESULTS,
    "actionKeys": len(agent.WORKER_ACTION_LAST_AT),
    "actionOldActive": "worker-0" in agent.WORKER_ACTION_LAST_AT,
    "actionOldInactive": "worker-1" in agent.WORKER_ACTION_LAST_AT,
    "actionNew": f"worker-{agent.MAX_WORKER_ACTION_KEY_RECORDS + 29}" in agent.WORKER_ACTION_LAST_AT,
    "dependencyCache": len(agent.SCHEDULER_DEPENDENCY_CACHE),
    "dependencyNewest": "scheduler-0" in agent.SCHEDULER_DEPENDENCY_CACHE,
    "dependencyOldInactive": f"scheduler-{agent.MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS + 29}" in agent.SCHEDULER_DEPENDENCY_CACHE,
    "dependencyActive": "active-old" in agent.SCHEDULER_DEPENDENCY_CACHE,
}, ensure_ascii=False))
