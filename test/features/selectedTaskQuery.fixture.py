"""Bound full result observation to the selected job, retaining broad discovery."""
import ast
import base64
import json
import os
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").split("String.raw`", 1)[1].rsplit("`", 1)[0]
names = {"task_inventory", "task_query", "task_safe_path", "task_public_observation"}
nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(nodes) == len(names)
root = os.path.realpath("/synthetic-project")
headers = [dict(root=root, lifecycleProtocol=2, commandId=str(i), projectId="project", workerId="w",
                outputDir="work/" + str(i), pane="%" + str(i), _se_payload={"parts": 80}) for i in range(180)]
reads, observations = [], []
exit_code = "0"
diagnostics = {"state": "clear", "scanComplete": True, "count": 0}
expect_full = True
def tmux(args):
    if args[0] == "capture-pane":
        return "synthetic nonzero exit"
    if args[0] == "list-panes" and "@sftp_cleanup_target" in args[-1]:
        return ""
    assert args[0] == "list-panes"
    return "\n".join("\t".join([h["pane"], "@" + h["commandId"], "mine-gpu-0", "1", exit_code,
                               base64.urlsafe_b64encode(json.dumps(h).encode()).decode(), "done", "0", "work/log"]) for h in headers)
def read_job(pane, encoded=None):
    reads.append(pane)
    h = json.loads(base64.urlsafe_b64decode(encoded).decode()) if encoded else next(h for h in headers if h["pane"] == pane)
    return {**h, "options": {"fullPayload": True}}
def observe(root, job, row=None):
    observations.append(job["commandId"])
    if row and expect_full:
        assert job["options"]["fullPayload"], "selected result must retain the verified full payload"
    return real_observe(root, job, row)
ns = dict(os=os, base64=base64, json=json, re=re, task_tmux=tmux, task_read_job=read_job,
          task_public_observation=observe, task_option=lambda *args: "[]", task_queue_session=lambda *args: "mine-sch",
          task_memory_scheduler_capability=lambda root: 1, now_iso=lambda: "now")
exec(compile(ast.Module(body=nodes, type_ignores=[]), "selected_query", "exec"), ns)
real_observe = ns["task_public_observation"]
ns["task_public_observation"] = observe
ns["task_manifest_observation"] = lambda root, job: dict(runId=job["commandId"], status="completed", present=True, verified=True, artifactsComplete=True, identityMatches=True, exitCode=0)
ns["task_log_diagnostics"] = lambda *args: diagnostics
query = {k: headers[0][k] for k in ("commandId", "projectId", "workerId", "outputDir")}
result = ns["task_query"](root, [query], selected_only=True)
assert result["queryComplete"] and len(result["tasks"]) == 1
assert reads == ["%0"] and observations == ["0"], "unrelated logs/manifests/source chunks caused sync timeouts"
assert result["tasks"][0]["successful"]
diagnostics = {"state": "anomalies", "scanComplete": True, "count": 1}
assert ns["task_query"](root, [query], selected_only=True)["tasks"][0]["completionState"] == "review_required"
exit_code = "1"
assert ns["task_query"](root, [query], selected_only=True)["tasks"][0]["status"] == "failed"
exit_code = "0"
diagnostics = {"state": "clear", "scanComplete": True, "count": 0}
reads.clear(); observations.clear()
expect_full = False
result = ns["task_query"](root, [query], selected_only=True, observation_only=True)
assert len(result["tasks"]) == 1 and not reads and observations == ["0"], "result progress must not load any launch payload"
reads.clear(); observations.clear()
result = ns["task_query"](root, [query])
assert len(result["tasks"]) == 180 and not reads, "progress discovery must retain all panes without reading launch source chunks"
try:
    ns["task_query"](root, [dict(query, workerId="other")], selected_only=True)
except ValueError as exc:
    assert "OWNER_MISMATCH" in str(exc)
else:
    raise AssertionError("foreign Worker selection accepted")
reads.clear(); observations.clear()
result = ns["task_query"](root, [dict(query, commandId="absent", outputDir="work/missing")], selected_only=True)
assert not reads and observations == ["absent"] and len(result["tasks"]) == 1
print(json.dumps({"ok": True, "selected": 1, "discovered": 180}))
