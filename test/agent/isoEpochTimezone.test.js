const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");

function runWithTimezone(timezone) {
  const script = String.raw`
import importlib.util, json, time

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

now = time.time()
def stamp(offset):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - offset))

print(json.dumps({
    "ageNow": agent.iso_age_seconds(agent.now_iso()),
    "ageOffsets": [agent.iso_age_seconds(stamp(offset)) for offset in (0, 60, 3600)],
    "fractionalStamp": agent.iso_age_seconds(stamp(0).replace("Z", ".000Z")),
    "invalid": agent.iso_age_seconds("not-a-timestamp"),
    "empty": agent.iso_age_seconds(""),
    "epochType": type(agent.parse_iso_epoch(stamp(0))).__name__,
}))
`;
  const env = { ...process.env };
  if (timezone) env.TZ = timezone;
  const run = spawnSync("python", ["-c", script], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim());
}

test("ISO stamps are read back as UTC regardless of host timezone", () => {
  const local = runWithTimezone(null);
  assert.ok(local.ageNow <= 2, `fresh stamp reported ${local.ageNow}s old`);
  assert.ok(local.ageOffsets[0] <= 2, `zero offset reported ${local.ageOffsets[0]}s`);
  assert.ok(Math.abs(local.ageOffsets[1] - 60) <= 2, `60s offset reported ${local.ageOffsets[1]}s`);
  assert.ok(Math.abs(local.ageOffsets[2] - 3600) <= 2, `3600s offset reported ${local.ageOffsets[2]}s`);
  assert.ok(local.fractionalStamp <= 2, "fractional stamps must parse");
  assert.equal(local.invalid, null);
  assert.equal(local.empty, null);
  assert.equal(local.epochType, "float");
});

test("ages stay correct on eastern and western host offsets", () => {
  for (const timezone of ["Asia/Shanghai", "America/New_York", "UTC"]) {
    const result = runWithTimezone(timezone);
    assert.ok(result.ageNow <= 2, `${timezone}: fresh stamp reported ${result.ageNow}s old`);
    assert.ok(Math.abs(result.ageOffsets[2] - 3600) <= 2, `${timezone}: hour-old stamp reported ${result.ageOffsets[2]}s`);
  }
});

test("epoch parsing uses calendar.timegm rather than local mktime", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /calendar\.timegm\(time\.strptime\(text, "%Y-%m-%dT%H:%M:%SZ"\)\)/);
  assert.doesNotMatch(source, /time\.mktime\(time\.strptime/);
});
