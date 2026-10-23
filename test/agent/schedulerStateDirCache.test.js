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

import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
scheduler = extract_runtime_functions(${JSON.stringify(schedulerPath)}, ["AGENT_STATE_DIR_CACHE", "MAX_AGENT_STATE_DIR_CACHE_RECORDS", "compute_scheduler_agent_state_dir", "resolve_scheduler_agent_state_dir"])

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

  const run = spawnSync("python", ["-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, script, "utf8"); console.log("kept Python fixture at " + d); return file; })()], { encoding: "utf8", timeout: 10000, windowsHide: true });
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
