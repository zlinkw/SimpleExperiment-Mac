const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadBuilders() {
  const sandbox = {
    hubControlStatusCache: new WeakMap(),
    workerTelemetryStatusCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("isWeakMapCacheKey"),
    extractFunction("tunnelAuthorityHost"),
    extractFunction("tunnelHttpEndpoint"),
    extractFunction("buildHubControlStatus"),
    extractFunction("buildWorkerTelemetryStatus"),
    "this.buildHub = buildHubControlStatus;",
    "this.buildWorkers = buildWorkerTelemetryStatus;",
  ].join("\n"), sandbox);
  return sandbox;
}

function registry(localPort = 18765) {
  return {
    hub: { id: "hub", tunnel: { localPort } },
    workers: [
      { id: "worker-a", tunnel: { localPort: localPort + 1 } },
      { id: "worker-b", tunnel: { localPort: localPort + 2 } },
    ],
  };
}

test("legacy Hub registry and probe inputs never create a current control summary", () => {
  const sandbox=loadBuilders(),probe={status:"ok",capabilities:{endpoints:{actions:true,fileList:true,scheduler:true}}};
  for(const candidate of [registry(),registry(19000),undefined])
    for(const current of [probe,{...probe,status:"local_port_closed"},undefined])assert.equal(sandbox.buildHub(candidate,current),undefined);
});

test("Worker telemetry summary reuses stable inputs and invalidates every source", () => {
  const sandbox = loadBuilders();
  const sourceRegistry = registry();
  const probes = {
    "worker-a": { status: "ok", capabilities: { endpoints: { gpu: true, workerTasks: false } } },
    "worker-b": { status: "local_port_closed" },
  };
  const realtime = {
    endpoints: [
      { id: "worker-a", streamStatus: "websocket", lastHeartbeatAt: "2026-07-30T00:01:00Z" },
      { id: "worker-b", streamStatus: "disconnected" },
    ],
  };
  const first = sandbox.buildWorkers(sourceRegistry, probes, realtime);

  assert.strictEqual(sandbox.buildWorkers(sourceRegistry, probes, realtime), first);
  assert.deepEqual(Array.from(first,(item) => item.status), ["online", "offline"]);
  assert.equal(first[0].gpuTelemetry, true);
  assert.equal(first[0].workerTaskTelemetry, false);

  const streamRefresh = sandbox.buildWorkers(sourceRegistry, probes, {
    endpoints: realtime.endpoints.map((item) => item.id === "worker-a" ? { ...item, streamStatus: "polling" } : item),
  });
  assert.notStrictEqual(streamRefresh, first);
  assert.equal(streamRefresh[0].status, "online");
  assert.equal(streamRefresh[0].eventStream, "polling");

  const probeRefresh = sandbox.buildWorkers(sourceRegistry, { ...probes, "worker-a": { status: "failed" } }, realtime);
  assert.notStrictEqual(probeRefresh, first);
  assert.equal(probeRefresh[0].status, "online");

  const registryRefresh = sandbox.buildWorkers(registry(19000), probes, realtime);
  assert.notStrictEqual(registryRefresh, first);
  assert.equal(registryRefresh[0].localPort, 19001);
});
