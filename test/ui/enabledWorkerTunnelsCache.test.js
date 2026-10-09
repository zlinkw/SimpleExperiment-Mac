const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("project and server views reuse enabled Worker filtering by source array", () => {
  let reads = 0;
  const worker = (id, enabled) => ({ id, get enabled() { reads += 1; return enabled; } });
  const firstSource = [worker("a", true), worker("b", false), null];
  const sandbox = {
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("enabledWorkerTunnelsForState") + "\nthis.enabledWorkers = enabledWorkerTunnelsForState;", sandbox);

  const first = sandbox.enabledWorkers({ setup: { workerTunnels: firstSource } });
  assert.deepEqual(first.map((item) => item.id), ["a"]);
  assert.equal(reads, 2);
  assert.equal(sandbox.enabledWorkers({ setup: { workerTunnels: firstSource } }), first);
  assert.equal(reads, 2);

  const second = sandbox.enabledWorkers({ setup: { workerTunnels: [worker("c", true)] } });
  assert.deepEqual(second.map((item) => item.id), ["c"]);
  assert.equal(reads, 3);
});

test("readiness and project/server consumers share enabled Worker cache", () => {
  for (const name of [
    "renderServerObjectOverview",
    "renderServerTopologyMap",
    "pruneGpuServerCacheForConfiguredState",
    "planConfiguredWorkerCapacity",
    "overviewSyncReadiness",
    "serverSetupReadiness",
    "executionWorkerReadiness",
    "projectEndpointReadiness",
    "projectCodeSyncReadiness",
  ]) {
    assert.match(extractFunction(name), /enabledWorkerTunnelsForState\(state\)/, name);
  }
});
