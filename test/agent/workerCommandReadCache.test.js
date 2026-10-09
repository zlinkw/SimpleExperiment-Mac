const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent Worker command reader resumes from a bounded file cursor", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-command-cursor-"));
  const script = path.join(project, "command-cursor.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(project)}
worker = "worker-a"
queue_path = pathlib.Path(agent.worker_command_path(root, worker))
queue_path.parent.mkdir(parents=True, exist_ok=True)
with queue_path.open("w", encoding="utf-8") as handle:
    for index in range(55):
        if index == 7:
            handle.write("{broken\\n")
        else:
            handle.write(json.dumps({"commandId": f"cmd-{index}"}) + "\\n")

first = agent.read_worker_commands(root, worker, 0, 20)
first_cursor = dict(agent.WORKER_COMMAND_CURSOR_CACHE[str(queue_path.resolve())])
second = agent.read_worker_commands(root, worker, first[-1]["queueSeq"], 20)
second_cursor = dict(agent.WORKER_COMMAND_CURSOR_CACHE[str(queue_path.resolve())])
retry = agent.read_worker_commands(root, worker, 0, 3)

agent.WORKER_COMMAND_CURSOR_CACHE.clear()
cache_now = 5000
for index in range(agent.MAX_WORKER_COMMAND_CURSOR_RECORDS + 12):
    agent.WORKER_COMMAND_CURSOR_CACHE[f"path-{index}"] = {"lastUsedAt": cache_now - index}
agent.WORKER_COMMAND_CURSOR_CACHE["active-old"] = {"lastUsedAt": cache_now - agent.WORKER_COMMAND_CURSOR_TTL_SECONDS - 1}
agent.prune_worker_command_cursor_cache(cache_now, "active-old")

print(json.dumps({
    "firstSeqs": [item["queueSeq"] for item in first],
    "secondSeqs": [item["queueSeq"] for item in second],
    "retrySeqs": [item["queueSeq"] for item in retry],
    "cursorAdvanced": second_cursor["offset"] > first_cursor["offset"],
    "cursorCount": len(agent.WORKER_COMMAND_CURSOR_CACHE),
    "cursorNewest": "path-0" in agent.WORKER_COMMAND_CURSOR_CACHE,
    "cursorOldInactive": f"path-{agent.MAX_WORKER_COMMAND_CURSOR_RECORDS + 11}" in agent.WORKER_COMMAND_CURSOR_CACHE,
    "cursorActive": "active-old" in agent.WORKER_COMMAND_CURSOR_CACHE,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.firstSeqs.length, 20);
  assert.deepEqual(result.firstSeqs.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 9]);
  assert.equal(result.secondSeqs[0], result.firstSeqs.at(-1) + 1);
  assert.equal(result.secondSeqs.length, 20);
  assert.deepEqual(result.retrySeqs, [1, 2, 3]);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(result.cursorCount, 64);
  assert.equal(result.cursorNewest, true);
  assert.equal(result.cursorOldInactive, false);
  assert.equal(result.cursorActive, true);
});

test("single Worker command processor does not replay old commands after Agent restart", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-command-restart-"));
  const script = path.join(project, "command-restart.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib, os
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
root = ${JSON.stringify(project)}
agent.AGENT_STATE_DIR = os.path.join(root, "state")
worker = "nwpu3"
agent._read_run_plan_registry = lambda root: [{"pid": 123}]
agent._is_pid_alive = lambda pid: True
queue = pathlib.Path(agent.worker_command_path(root, worker))
queue.parent.mkdir(parents=True, exist_ok=True)
with queue.open("w", encoding="utf-8") as handle:
    for name in ("old-start", "old-stop"):
        handle.write(json.dumps({"commandId": name, "action": "start-worker-task" if name == "old-start" else "stop-worker-task"}) + "\\n")
executed = []
agent.execute_worker_command = lambda root, command, worker_id: executed.append(command["commandId"])
agent.time.sleep = lambda seconds: (_ for _ in ()).throw(SystemExit())
class OneCycleThread:
    def __init__(self, target=None, **kwargs): self.target = target
    def start(self):
        try: self.target()
        except SystemExit: pass
agent.threading.Thread = OneCycleThread
agent.start_worker_local_command_processor(root, worker, 1, 0)
assert executed == ["old-start", "old-stop"], executed
executed.clear()
agent.WORKER_COMMAND_CURSOR_CACHE.clear()
agent.start_worker_local_command_processor(root, worker, 1, 0)
assert executed == [], f"replayed after restart: {executed}"
with queue.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps({"commandId": "new-start", "action": "start-worker-task"}) + "\\n")
agent.start_worker_local_command_processor(root, worker, 1, 0)
assert executed == ["new-start"], executed
executed.clear()
queue.write_text(json.dumps({"commandId": "rotated-start", "action": "start-worker-task"}) + "\\n", encoding="utf-8")
agent.WORKER_COMMAND_CURSOR_CACHE.clear()
agent.start_worker_local_command_processor(root, worker, 1, 0)
assert executed == ["rotated-start"], executed
executed.clear()
old_root = os.path.join(root, "old-project")
os.makedirs(old_root)
agent.AGENT_STATE_DIR = os.path.join(old_root, "state")
agent._read_run_plan_registry = lambda root: []
old_queue = pathlib.Path(agent.worker_command_path(old_root, worker))
old_queue.parent.mkdir(parents=True, exist_ok=True)
old_queue.write_text(json.dumps({"commandId": "abandoned-start", "action": "start-worker-task"}) + "\\n", encoding="utf-8")
agent.start_worker_local_command_processor(old_root, worker, 1, 0)
assert executed == [], f"abandoned Plan replayed during cursor migration: {executed}"
print("durable queue cursor ok")
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /durable queue cursor ok/);
});
