"""Extract only the real query function; no Agent import, file writes or training."""
import ast
import json
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
python = text.split("String.raw`", 1)[1].rsplit("`", 1)[0]
tree = ast.parse(python)
query = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "task_query")
live = dict(projectId="project", commandId="live", workerId="worker", outputDir="work/live", dead=False)
ns = dict(json=json, now_iso=lambda: "now", task_inventory=lambda root, **kwargs: [live],
          task_memory_scheduler_capability=lambda root: 0,
          task_safe_path=lambda root, path: path, task_tmux=lambda args: "",
          task_option=lambda *args: "[]", task_queue_session=lambda *args: "queue",
          task_public_observation=lambda root, job, row: dict(commandId=job["commandId"], status="running" if row else "unknown", observation={}))
exec(compile(ast.Module(body=[query], type_ignores=[]), "real-query", "exec"), ns)
bad = [dict(commandId="old-" + str(index), workerId="worker", outputDir="work/old") for index in range(99)]
result = ns["task_query"]("/fixture", bad + [live, None, "legacy"])
assert result["queryComplete"] is True
assert len(result["queryErrors"]) == 101
assert [row["commandId"] for row in result["tasks"]] == ["live"]
assert all("TASK_QUERY_IDENTITY_REQUIRED" in row["error"] for row in result["queryErrors"])
declared = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "task_declared_results")
ns["task_manifest_observation"] = lambda root, job: dict(status="completed", verified=True, runId="done", job=dict(index=0, case="a", seed=42))
exec(compile(ast.Module(body=[declared], type_ignores=[]), "real-declared-query", "exec"), ns)
declarations = [dict(index=0, case="a", seed=42, mode="train_test", output_dir="work/a", result_csv="tmp/a.csv"),
                dict(index=1, case="b", seed=42, mode="train_test", output_dir="work/b", result_csv="tmp/b.csv"), None]
results = ns["task_declared_results"]("/fixture", declarations)
assert [row["completed"] for row in results] == [True, False, False]
assert results[2]["error"]
for dead, exit_code, expected in [(False, None, False), (True, 7, False), (True, None, True), (True, 0, True)]:
    task = dict(outputDir="work/a", commandId="done", observation=dict(tmux=dict(dead=dead, exitCode=exit_code)))
    assert ns["task_declared_results"]("/fixture", declarations[:1], [task])[0]["completed"] is expected
active_new = dict(outputDir="work/a", commandId="new", observation=dict(tmux=dict(dead=False, exitCode=None)))
assert ns["task_declared_results"]("/fixture", declarations[:1], [active_new])[0]["completed"] is False
uncertain = dict(outputDir="work/a", commandId="done", observation=dict(queryError="unreachable"))
assert ns["task_declared_results"]("/fixture", declarations[:1], [uncertain])[0]["completed"] is False
unrelated = dict(outputDir="work/b", commandId="other", observation=dict(tmux=dict(dead=True, exitCode=7)))
assert ns["task_declared_results"]("/fixture", declarations[:1], [unrelated])[0]["completed"] is True
ns["task_manifest_observation"] = lambda root, job: dict(status="completed", verified=True, runId="", job=dict(index=0, case="a", seed=42))
assert ns["task_declared_results"]("/fixture", declarations[:1])[0]["completed"] is False
print(json.dumps(dict(ok=True, invalidHistoryIsolated=101, livePreserved=True)))
