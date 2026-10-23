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

if True:
    tmp = tempfile.mkdtemp(prefix="historical-plan-queue-input-")
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
    const result = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], { cwd: root, env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        TEST_SCHEDULER_PATH: path.join(root, "dist", "runtime", "cluster_scheduler.py"),
      }, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    console.log("kept queue probe at " + scriptPath);
  }
});

test("current task queries use protocol 2 and cannot replay the historical durable queue", () => {
  const runtime=path.join(root,"dist/runtime/cluster_agent.py");
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"native-query-boundary-")),file=path.join(folder,"probe.py");
  fs.writeFileSync(file,`
import ast,pathlib
source=pathlib.Path(${JSON.stringify(runtime)}).read_text(encoding="utf-8")
function=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=="api_worker_tasks")
seen=[]
def query(root,queries):
    seen.append((root,queries))
    return {"queryComplete":True,"lifecycleProtocol":2}
def retired(*args):raise AssertionError("historical durable queue was touched")
ns={"TASK_LIFECYCLE_PROTOCOL":2,"task_query":query,"read_runtime_json_cached":retired,"sync_durable_plan_task_rows":retired,"reconcile_worker_task_exit_codes":retired}
exec(compile(ast.Module(body=[function],type_ignores=[]),"isolated-api-worker-tasks","exec"),ns)
assert ns["api_worker_tasks"]("/fixture")["queryComplete"]
selection=[{"commandId":"original-command"}]
assert ns["api_worker_tasks"]("/fixture",queries=selection)["lifecycleProtocol"]==2
assert seen==[("/fixture",[]),("/fixture",selection)],seen
print("ok")
`);
  const result=spawnSync(process.platform==="win32"?"python":"python3",["-B","-X","utf8",file],{encoding:"utf8",timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
