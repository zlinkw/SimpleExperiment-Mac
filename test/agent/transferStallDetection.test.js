const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("transfer records derive percent and flag abandoned running transfers", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import importlib.util, json, time

import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(${JSON.stringify(agentPath)}, ["TRANSFER_STALL_SECONDS", "public_transfer_record", "transfer_int"])

now = time.time()
def stamp(offset):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - offset))

live = agent.public_transfer_record({"transferId": "t1", "status": "running", "totalBytes": 1000, "transferredBytes": 250, "updatedAt": stamp(5)})
stalled = agent.public_transfer_record({"transferId": "t2", "status": "running", "totalBytes": 1000, "transferredBytes": 250, "updatedAt": stamp(600)})
finished = agent.public_transfer_record({"transferId": "t3", "status": "completed", "totalBytes": 1000, "transferredBytes": 1000, "updatedAt": stamp(600)})
upload = agent.public_transfer_record({"transferId": "t4", "status": "running", "expectedSize": 800, "receivedBytes": 200, "updatedAt": stamp(1)})
unknown = agent.public_transfer_record({"transferId": "t5", "status": "running", "updatedAt": stamp(1)})
overshoot = agent.public_transfer_record({"transferId": "t6", "status": "running", "totalBytes": 100, "transferredBytes": 250, "updatedAt": stamp(1)})
garbage = agent.public_transfer_record({"transferId": "t7", "status": "running", "totalBytes": "abc", "transferredBytes": None, "updatedAt": stamp(1)})

print(json.dumps({
    "livePercent": live.get("percent"),
    "liveStalled": live.get("stalled", False),
    "stalledFlag": stalled.get("stalled", False),
    "stalledFor": stalled.get("stalledForSeconds", 0) >= 600,
    "finishedStalled": finished.get("stalled", False),
    "uploadPercent": upload.get("percent"),
    "unknownHasPercent": "percent" in unknown,
    "overshootPercent": overshoot.get("percent"),
    "garbageHasPercent": "percent" in garbage,
    "threshold": agent.TRANSFER_STALL_SECONDS,
    "intFallback": [agent.transfer_int(None, 7), agent.transfer_int("", 7), agent.transfer_int("12.9"), agent.transfer_int("nope", 3)],
}))
`;

  const run = spawnSync("python", ["-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, script, "utf8"); console.log("kept Python fixture at " + d); return file; })()], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.livePercent, 25);
  assert.equal(result.liveStalled, false);
  assert.equal(result.stalledFlag, true);
  assert.equal(result.stalledFor, true);
  assert.equal(result.finishedStalled, false, "terminal transfers must never be reported as stalled");
  assert.equal(result.uploadPercent, 25);
  assert.equal(result.unknownHasPercent, false, "an unknown total must not fabricate a percent");
  assert.equal(result.overshootPercent, 100, "percent must clamp at 100");
  assert.equal(result.garbageHasPercent, false);
  assert.equal(result.threshold, 120);
  assert.deepEqual(result.intFallback, [7, 7, 12, 3]);
});

test("stall detection reuses the UTC-safe age helper", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /TRANSFER_STALL_SECONDS = 120/);
  assert.match(source, /age = iso_age_seconds\(out\.get\("updatedAt"\)\)/);
  assert.match(source, /out\["percent"\] = round\(min\(100\.0, max\(0\.0, done \* 100\.0 \/ total\)\), 1\)/);
  assert.match(source, /def transfer_int\(value, fallback=0\)/);
});
