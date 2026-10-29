import os
import re
import sys
import types
from pathlib import Path

# Execute only the startup prefix, never import the Agent or its file queues.
text = Path(sys.argv[1]).read_text(encoding="utf-8")
prefix = text.split("def serve_http(args):", 1)[1].split("    class BoundedThreadingHTTPServer", 1)[0]
events = []

def record(name):
    def call(*args, **kwargs):
        events.append(name)
    return call

def forbidden(*args, **kwargs):
    raise AssertionError("historical task reconciliation/cleanup blocked HTTP readiness")

scope = dict(os=os, re=re, sys=sys, RUNTIME_VERSION="test", AGENT_VERSION="test",
             lifecycle_service_guard=lambda *args: (object(), {"nonce": "owned"}),
             task_update_scheduler_runtime=record("scheduler"),
             prune_agent_state=forbidden, reconcile_worker_tasks_after_restart=forbidden,
             atomic_write=record("session"), path_for=lambda *args: "session",
             now_iso=lambda: "now", agent_install_dir=lambda root: "install",
             agent_dir=lambda root: "state", STATE_RETENTION_SECONDS=0, MAX_AGENT_STATE_BYTES=0,
             start_worker_telemetry_sampler=record("telemetry"), start_gpu_log_tail_sampler=record("logs"))
exec("def startup(args):" + prefix, scope)
scope["startup"](types.SimpleNamespace(host="127.0.0.1", project_dir="fixture", token="", mode="worker_telemetry", worker_id="test"))
assert events == ["scheduler", "session", "telemetry", "logs"], events
assert scope["AGENT_LIFECYCLE_IDENTITY"]["nonce"] == "owned"
print("owned startup reaches HTTP without historical task/file scans")
