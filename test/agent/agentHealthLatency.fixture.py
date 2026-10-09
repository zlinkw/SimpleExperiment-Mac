"""Exercise only extracted health functions, never import the Agent runtime."""
import ast
import concurrent.futures
import json
import os
import sys
import threading
import time
import types

source = open(sys.argv[1], encoding="utf-8").read()
names = {"api_health", "scheduler_dependency_health", "scheduler_dependency_health_key", "prune_scheduler_dependency_cache"}
functions = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in names]
space = dict(os=os, sys=sys, time=time, threading=threading, json=json,
             SCHEDULER_DEPENDENCY_CACHE={}, SCHEDULER_DEPENDENCY_IN_FLIGHT={},
             SCHEDULER_DEPENDENCY_CACHE_LOCK=threading.Lock(),
             MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS=32, SCHEDULER_DEPENDENCY_CACHE_TTL_SECONDS=600,
             SCHEMA_VERSION=1, AGENT_VERSION="test", RUNTIME_VERSION="test", PLUGIN_VERSION="test", API_VERSION="1",
             read_runtime_json_cached=lambda *_: {}, path_for=lambda root, name: root + "/" + name,
             inspect_agent=lambda root: {}, iso_age_seconds=lambda *_: 0,
             agent_install_dir=lambda root: root + "/agent", agent_dir=lambda root: root + "/state",
             now_iso=lambda: "2026-10-07T00:00:00Z", cluster_scheduler_path=lambda root: root + "/scheduler.py",
             simple_runtime_env=lambda *_: {"SIMPLE_EXPERIMENT_CONDA_ENV": "/env"},
             simple_runtime_python=lambda *_: "/env/bin/python", relpath=lambda root, value: value)
exec(compile(ast.Module(body=functions, type_ignores=[]), "extracted-health", "exec"), space)

release = threading.Event()
calls = []
def check(root, scheduler, env):
    calls.append((root, scheduler))
    release.wait(0.4)
    return {"ok": True, "missingModules": [], "message": "ready"}
space["scheduler_dependency_status"] = check
started = time.perf_counter()
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    cold = list(pool.map(lambda _: space["api_health"]("/project", "worker_telemetry"), range(8)))
cold_ms = (time.perf_counter() - started) * 1000
cold_calls = len(calls)
release.set()
deadline = time.monotonic() + 1
while space["SCHEDULER_DEPENDENCY_IN_FLIGHT"] and time.monotonic() < deadline:
    time.sleep(0.005)
warm = space["api_health"]("/project", "worker_telemetry")["schedulerDependencies"]

# A stale dependency refresh must not block the health route or fan out subprocesses.
for value in space["SCHEDULER_DEPENDENCY_CACHE"].values():
    value["_checkedAtEpoch"] = time.time() - 60
release.clear()
started = time.perf_counter()
stale = space["api_health"]("/project", "worker_telemetry")["schedulerDependencies"]
stale_ms = (time.perf_counter() - started) * 1000
release.set()
while space["SCHEDULER_DEPENDENCY_IN_FLIGHT"] and time.monotonic() < deadline:
    time.sleep(0.005)

# A different scheduler or interpreter must not reuse an old successful identity.
release.clear()
space["cluster_scheduler_path"] = lambda root: root + "/new-scheduler.py"
changed = space["api_health"]("/project", "worker_telemetry")["schedulerDependencies"]
release.set()

# Identity includes file changes in place and configured runtime environment changes.
stamp = [1]
space["os"] = types.SimpleNamespace(path=os.path, stat=lambda _: types.SimpleNamespace(st_size=12, st_mtime_ns=stamp[0]))
env = {"SIMPLE_EXPERIMENT_CONDA_ENV": "/env", "PYTHONPATH": "/module-a"}
key_before = space["scheduler_dependency_health_key"]("/project", "/scheduler", env)
stamp[0] = 2
file_identity_changed = space["scheduler_dependency_health_key"]("/project", "/scheduler", env) != key_before
stamp[0] = 1
env["PYTHONPATH"] = "/module-b"
env_identity_changed = space["scheduler_dependency_health_key"]("/project", "/scheduler", env) != key_before
print(json.dumps({"coldMs": cold_ms, "coldCalls": cold_calls,
                  "coldPending": all(row["schedulerDependencies"].get("pending") is True for row in cold),
                  "warmReady": warm.get("ok") is True and not warm.get("pending"),
                  "staleMs": stale_ms, "stalePending": stale.get("pending") is True,
                  "changedPending": changed.get("pending") is True, "changedOk": changed.get("ok"),
                  "fileIdentityChanged": file_identity_changed, "envIdentityChanged": env_identity_changed}, ensure_ascii=False))
