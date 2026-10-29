"""Extract the real task query; only synthetic tmux rows, no full runtime import."""
import ast
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(source.split("String.raw`", 1)[1].rsplit("`", 1)[0])
query = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "task_query")
failed = dict(projectId="project", commandId="failed", workerId="worker", outputDir="work/failed", dead=True, exitCode=1, tmuxPane="%1")
running = dict(projectId="project", commandId="running", workerId="worker", outputDir="work/running", dead=False, tmuxPane="%2")
def observe(root, job, row):
    return dict(commandId=job["commandId"], projectId=job["projectId"], status="failed" if row and row["dead"] else "running" if row else "unknown", observation={})
ns = dict(json=json, now_iso=lambda: "now", task_inventory=lambda root, **kwargs: [failed, running],
          task_memory_scheduler_capability=lambda root: 0, task_safe_path=lambda root, path: path,
          task_tmux=lambda args: "ValueError: project configuration mismatch" if args[0] == "capture-pane" else "",
          task_option=lambda *args: "[]", task_queue_session=lambda *args: "queue", task_public_observation=observe)
exec(compile(ast.Module(body=[query], type_ignores=[]), "real-query", "exec"), ns)
for queries in ([failed, running], [running], [], [running]):
    result = ns["task_query"]("/fixture", queries)
    tasks = {row["commandId"]: row for row in result["tasks"]}
    assert tasks.get("failed", {}).get("status") == "failed", tasks
    assert tasks["running"]["status"] == "running"
print(json.dumps(dict(ok=True,stableQueries=4)))
