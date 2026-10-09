const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");
const { PptPlotBridge } = require("../../dist/PptPlotBridge.js");

const root = path.join(__dirname, "../..");

test("sampler and scheduler timing functions use half-second intervals", () => {
  const agentSource = path.join(root, "dist/runtime/cluster_agent.py");
  const schedulerSource = path.join(root, "dist/runtime/cluster_scheduler.py");
  const scriptPath = path.join(os.tmpdir(), `runtime-refresh-timing-${process.pid}.py`);
  const agentPathLiteral = JSON.stringify(agentSource);
  const schedulerPathLiteral = JSON.stringify(schedulerSource);
  fs.writeFileSync(scriptPath, `
import ast, json, pathlib
from types import SimpleNamespace

def runtime_source(path):
    return pathlib.Path(path).read_text(encoding="utf-8")

agent_tree = ast.parse(runtime_source(${agentPathLiteral}))
scheduler_tree = ast.parse(runtime_source(${schedulerPathLiteral}))
allowed = {"sampler_interval_seconds", "sampler_sleep_seconds", "worker_gpu_sample_delay", "wait_for_worker_gpu_sample"}
agent_nodes = [node for node in agent_tree.body if isinstance(node, ast.FunctionDef) and node.name in allowed]
scheduler_allowed = {"scheduler_min_poll_interval", "scheduler_signal_requires_refresh"}
scheduler_nodes = [node for node in scheduler_tree.body if
    (isinstance(node, ast.FunctionDef) and node.name in scheduler_allowed) or
    (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id.startswith("SCHEDULER_SIGNAL_") for target in node.targets))]
agent_ns = {"time": SimpleNamespace(sleep=lambda seconds: sleeps.append(seconds)),
            "random": SimpleNamespace(random=lambda: 1.0),
            "has_running_plan": lambda root: bool(sleeps)}
sleeps = []
exec(compile(ast.Module(body=agent_nodes, type_ignores=[]), "agent-functions", "exec"), agent_ns)
scheduler_ns = {}
exec(compile(ast.Module(body=scheduler_nodes, type_ignores=[]), "scheduler-functions", "exec"), scheduler_ns)
agent_ns["wait_for_worker_gpu_sample"]("/project", 60, 30, True)
agent_ns["wait_for_worker_gpu_sample"]("/project", 60, 30, False)
task_end = scheduler_ns["SCHEDULER_SIGNAL_TASK_END"]
print(json.dumps({
    "samplerInterval": agent_ns["worker_gpu_sample_delay"](60, 30, True),
    "activeDelay": agent_ns["worker_gpu_sample_delay"](60, 30, True),
    "idleDelay": agent_ns["worker_gpu_sample_delay"](60, 30, False),
    "actualSleeps": sleeps,
    "minimumPoll": scheduler_ns["scheduler_min_poll_interval"](0.1),
    "zeroPoll": scheduler_ns["scheduler_min_poll_interval"](0),
    "fractionalPoll": scheduler_ns["scheduler_min_poll_interval"](1.25),
    "defaultPoll": scheduler_ns["scheduler_min_poll_interval"](600),
    "laterTaskEndsStillDispatch": [scheduler_ns["scheduler_signal_requires_refresh"](task_end) for _ in range(2)],
}))
`, "utf8");
  let result;
  try {
    result = spawnSync("python", [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 10000,
      windowsHide: true,
    });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    samplerInterval: 5.0,
    activeDelay: 5.0,
    idleDelay: 90.0,
    actualSleeps: [5.0, 5.0],
    minimumPoll: 0.5,
    zeroPoll: 0.5,
    fractionalPoll: 1.25,
    defaultPoll: 600,
    laterTaskEndsStillDispatch: [true, true],
  });

  const scheduler = readSource("src/clusterSchedulerRuntime.legacy.ts");
  const agent = readSource("src/clusterAgentRuntime.legacy.ts");
  assert.match(agent, /def start_worker_telemetry_sampler[\s\S]*?interval = sampler_interval_seconds\(poll_seconds, 60\.0\)/);
  assert.match(agent, /def start_hub_control_sampler[\s\S]*?interval = sampler_interval_seconds\(poll_seconds, 60\.0\)/);
  assert.match(agent, /def start_worker_hub_uplink[\s\S]*?availability_base = 0\.5[\s\S]*?jitter = 0\.0[\s\S]*?event_delay = 0\.5/);
  assert.match(scheduler, /add_argument\("--poll-seconds", type=float, default=600\)/);
  assert.match(scheduler, /session_check_min_seconds = max\(0\.5, float\(args\.session_check_min_seconds/);
  assert.doesNotMatch(scheduler, /SCHEDULER_SIGNAL_DEBOUNCE|_last_signal_monotonic|_is_dup_signal|_is_dup_poll/);
  assert.match(scheduler, /sleep_slice = min\(0\.5, sleep_target - slept\)[\s\S]*?time\.sleep\(sleep_slice\)[\s\S]*?slept \+= sleep_slice/);
  assert.match(scheduler, /_pending_signal_type = _sig/);
});

test("PowerPoint launch can repeat after completion and still shares an in-flight launch", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = new PptPlotBridge({ launchPowerPoint: () => { calls += 1; return gate; } });
  const first = bridge.launchPowerPointOnce("first.pptx");
  const second = bridge.launchPowerPointOnce("second.pptx");
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  bridge.launchPowerPoint = () => { calls += 1; };
  await bridge.launchPowerPointOnce("later.pptx");
  assert.equal(calls, 2);
});
