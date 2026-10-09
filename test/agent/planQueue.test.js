const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");

test("Plans queue by Worker, release in order, and do not block another Worker", () => {
  const scriptPath = path.join(os.tmpdir(), `plan-queue-${process.pid}-${Date.now()}.py`);
  const script = String.raw`
import argparse, ast, json, os, pathlib, tempfile, time

source = pathlib.Path(os.environ["TEST_SCHEDULER_PATH"]).read_text(encoding="utf-8")
tree = ast.parse(source)
wanted = {"plan_queue_predecessors_pending", "wait_for_plan_queue", "scheduler_exit_code_ready", "scheduler_pid_is_alive", "append_log", "now"}
body = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)) or getattr(node, "name", None) in wanted]
module = ast.Module(body=body, type_ignores=[])
ast.fix_missing_locations(module)
namespace = {"__builtins__": __builtins__, "Path": pathlib.Path, "argparse": argparse, "time": time}
exec(compile(module, os.environ["TEST_SCHEDULER_PATH"], "exec"), namespace)
def alive_kill(pid, sig):
    if int(pid or 0) <= 0 or int(sig) != 0:
        raise OSError(pid)
namespace["os"].kill = alive_kill
plan_queue_predecessors_pending = namespace["plan_queue_predecessors_pending"]
wait_for_plan_queue = namespace["wait_for_plan_queue"]

def write_registry(registry, entries):
    registry.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")

def entry(op_id, pid, workers, owner, status="running"):
    return {"opId": op_id, "pid": pid, "workerIds": workers, "ownerWorkerId": owner, "status": status, "reservedAt": time.time()}

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    registry = root / "active_run_plans.json"
    write_registry(registry, [entry("first", os.getpid(), ["worker-a"], "worker-a")])
    assert entry("first", os.getpid(), ["worker-a"], "worker-a")["ownerWorkerId"] != "worker-b"
    write_registry(registry, [
        entry("first", os.getpid(), ["worker-a"], "worker-a"),
        entry("other", os.getpid(), ["worker-b"], "worker-b"),
    ])
    third_wait = ["first", "second"]
    write_registry(registry, [
        entry("first", os.getpid(), ["worker-a"], "worker-a"),
        entry("other", os.getpid(), ["worker-b"], "worker-b"),
        entry("second", os.getpid(), ["worker-a"], "worker-a", "queued"),
    ])
    rows = json.loads(registry.read_text(encoding="utf-8"))
    assert [row["opId"] for row in rows] == ["first", "other", "second"]
    got = plan_queue_predecessors_pending(registry, third_wait, root)
    assert got == third_wait, (got, rows)
    exit_dir = root / "simple_cluster" / "tmp" / "cluster_scheduler"
    exit_dir.mkdir(parents=True)
    (exit_dir / "first.exit_code").write_text("0", encoding="utf-8")
    assert plan_queue_predecessors_pending(registry, third_wait, root) == ["second"]
    (exit_dir / "second.exit_code").write_text("1", encoding="utf-8")
    assert plan_queue_predecessors_pending(registry, third_wait, root) == []
    assert "other" not in third_wait
    emitted = []
    namespace["append_scheduler_operation_event"] = lambda _args, status, message: emitted.append((status, message))
    (exit_dir / "second.exit_code").unlink()
    assert plan_queue_predecessors_pending(registry, third_wait, root) == ["second"]
    (exit_dir / "second.exit_code").write_text("0", encoding="utf-8")
    assert plan_queue_predecessors_pending(registry, third_wait, root) == []
    args = argparse.Namespace(
        wait_for_operations="first,second",
        plan_queue_registry=str(registry),
        plan_queue_project_dir=str(root),
        scheduler_log=str(root / "queue.log"),
        scheduler_owner_worker_id="worker-a",
    )
    wait_for_plan_queue(args)
    assert emitted == [("running", "前序 Plan 已完成，开始检测空卡并派发任务。")], emitted
    assert "plan_queue_released" in (root / "queue.log").read_text(encoding="utf-8")
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const result = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        TEST_SCHEDULER_PATH: path.join(root, "dist", "runtime", "cluster_scheduler.py"),
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
});

test("Plan submission keeps task-end GPU wake path and sends one Worker", () => {
  const agent = fs.readFileSync(path.join(root, "src", "clusterAgentRuntime.legacy.ts"), "utf8");
  const scheduler = fs.readFileSync(path.join(root, "src", "clusterSchedulerRuntime.legacy.ts"), "utf8");
  const extension = fs.readFileSync(path.join(root, "src", "extension", "legacy.ts"), "utf8");
  assert.match(agent, /if len\(workers\) != 1/);
  assert.match(agent, /"queued" if queue_wait else "running"/);
  assert.match(scheduler, /if reap_finished_items\(\):[\s\S]*?_pending_signal_type = SCHEDULER_SIGNAL_TASK_END/);
  assert.match(scheduler, /refresh_worker_availability_for_signal\(workers, args\.availability_path, force=_force_refresh\)/);
  assert.doesNotMatch(extension, /单 Worker 当前仅支持一个活动 Plan 调度器/);
});
