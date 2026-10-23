const { writePythonFixture } = require("../_helpers/isolatedPythonFixture");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const scheduler = path.join(root, "dist/runtime/cluster_scheduler.py");
const agent = path.join(root, "dist/runtime/cluster_agent.py");

test("scheduler ignores log wording and stops only for recorded task failure", () => {
  const script = `import importlib.util, json, sys
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
module = extract_runtime_functions(sys.argv[1], ["scheduler_should_fail_fast"])
out = [
  module.scheduler_should_fail_fast([], {"gpu": {"console_tail": "ERROR recoverable", "exit_code": None}}, {}),
  module.scheduler_should_fail_fast([], {"gpu": {"console_tail": "ordinary output"}}, {}),
  module.scheduler_should_fail_fast([{"experiment_index": 1, "error": "exit_code=1"}], {}, {}),
]
print(json.dumps(out))`;
  const result = spawnSync("python", [writePythonFixture(script), scheduler], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), [false, false, true]);
});

test("failed panes remain visible and a later task gets a separate window", () => {
  const source = fs.readFileSync(agent, "utf8");
  const launch = source.slice(source.indexOf("def start_job_in_gpu_pane("), source.indexOf("def _resolve_dynamic_gpu_ids("));
  const waiter = source.slice(source.indexOf("    def wait_task():"), source.indexOf("def worker_command_plan_mode("));
  assert.match(launch, /\["tmux", "new-window", "-d"/);
  assert.match(launch, /exec bash/);
  assert.match(waiter, /if used_tmux and rc == 0:\s*_recycle_after_task\(\)/);
  assert.doesNotMatch(waiter, /except Exception as exc:[\s\S]{0,400}_recycle_after_task\(\)/);
});
