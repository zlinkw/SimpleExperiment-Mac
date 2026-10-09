const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("scheduler agent state dir resolution is memoized per absolute project and configured pair", () => {
  const schedulerPath = path.join(__dirname, "../../dist/runtime/cluster_scheduler.py");
  const script = String.raw`
import importlib.util, json, os, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("cluster_scheduler", ${JSON.stringify(schedulerPath)})
scheduler = importlib.util.module_from_spec(spec)
sys.modules["cluster_scheduler"] = scheduler
spec.loader.exec_module(scheduler)

computes = {"count": 0}
real_compute = scheduler.compute_scheduler_agent_state_dir
def counted(project_dir=".", configured=""):
    computes["count"] += 1
    return real_compute(project_dir, configured)
scheduler.compute_scheduler_agent_state_dir = counted

root = Path(os.getcwd()).resolve()
first = scheduler.resolve_scheduler_agent_state_dir(root, "")
second = scheduler.resolve_scheduler_agent_state_dir(root, "")
cached_computes = computes["count"]

configured = scheduler.resolve_scheduler_agent_state_dir(root, "custom/agent/state")
configured_again = scheduler.resolve_scheduler_agent_state_dir(root, "custom/agent/state")
distinct_computes = computes["count"]

relative_first = scheduler.resolve_scheduler_agent_state_dir(".", "")
relative_second = scheduler.resolve_scheduler_agent_state_dir(".", "")
relative_computes = computes["count"] - distinct_computes

for index in range(scheduler.MAX_AGENT_STATE_DIR_CACHE_RECORDS + 2):
    scheduler.resolve_scheduler_agent_state_dir(root, "variant-%d" % index)
bounded_records = len(scheduler.AGENT_STATE_DIR_CACHE)

print(json.dumps({
    "cachedComputes": cached_computes,
    "distinctComputes": distinct_computes,
    "relativeComputes": relative_computes,
    "boundedRecords": bounded_records,
    "maxRecords": scheduler.MAX_AGENT_STATE_DIR_CACHE_RECORDS,
    "sameDefault": str(first) == str(second),
    "defaultMatchesCompute": str(first) == str(real_compute(root, "")),
    "configuredStable": str(configured) == str(configured_again),
    "configuredDiffersFromDefault": str(configured) != str(first),
    "relativeStable": str(relative_first) == str(relative_second),
}))
`;

  const run = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.cachedComputes, 1);
  assert.equal(result.distinctComputes, 2);
  assert.equal(result.relativeComputes, 2);
  assert.ok(result.boundedRecords <= result.maxRecords, `cache grew to ${result.boundedRecords}`);
  assert.equal(result.sameDefault, true);
  assert.equal(result.defaultMatchesCompute, true);
  assert.equal(result.configuredStable, true);
  assert.equal(result.configuredDiffersFromDefault, true);
  assert.equal(result.relativeStable, true);
});

test("scheduler state dir cache keeps the derivation split between compute and lookup", () => {
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(source, /def compute_scheduler_agent_state_dir\(project_dir: str \| Path = "\.", configured: str = ""\)/);
  assert.match(source, /if not raw\.is_absolute\(\):\n {8}return compute_scheduler_agent_state_dir\(project_dir, configured\)/);
  assert.match(source, /AGENT_STATE_DIR_CACHE\[cache_key\] = resolved/);
});
