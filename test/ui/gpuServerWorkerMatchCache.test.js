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

function loadGpuLookup() {
  const sandbox = {
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    GPU_SERVER_UNCONFIGURED_INDEX: 10000,
    gpuWorkerLookupCacheSource: null,
    gpuWorkerLookupCacheValue: null,
    gpuServerWorkerMatchCacheLookup: null,
    gpuServerWorkerMatchCache: new WeakMap(),
    aliasCalls: 0,
    naturalCompare: (a, b) => String(a).localeCompare(String(b)),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("gpuWorkerLookupForState"),
    extractFunction("gpuServerWorkerMatch"),
    extractFunction("gpuServerConfigIndex"),
    extractFunction("gpuServerDisplayName"),
    extractFunction("gpuServerSortLabel"),
    extractFunction("sortGpuServers"),
    extractFunction("cleanEndpointId"),
    "const rawAliases = " + extractFunction("gpuServerAliases") + ";",
    "function gpuServerAliases(server) { aliasCalls += 1; return rawAliases(server); }",
    "this.match = gpuServerWorkerMatch;",
    "this.configIndex = gpuServerConfigIndex;",
    "this.displayName = gpuServerDisplayName;",
    "this.sortServers = sortGpuServers;",
  ].join("\n"), sandbox);
  return sandbox;
}

function stateWithWorkers(workers) {
  return { setup: { workerTunnels: workers } };
}

test("GPU server worker match is resolved once per server object", () => {
  const sandbox = loadGpuLookup();
  const state = stateWithWorkers([
    { id: "worker-a", displayName: "A 节点" },
    { id: "worker-b", displayName: "B 节点" },
  ]);
  const server = { serverId: "worker-b", gpuRows: [] };

  const first = sandbox.match(state, server);
  const aliasCallsAfterFirst = sandbox.aliasCalls;
  assert.equal(first.index, 1);
  assert.equal(sandbox.configIndex(state, server), 1);
  assert.equal(sandbox.displayName(state, server), "B 节点");
  assert.equal(sandbox.match(state, server), first);
  assert.equal(sandbox.aliasCalls, aliasCallsAfterFirst);
});

test("GPU server match invalidates when the configured worker list changes", () => {
  const sandbox = loadGpuLookup();
  const server = { serverId: "worker-a", displayName: "回退名" };
  const before = stateWithWorkers([{ id: "worker-a", displayName: "旧名" }]);
  assert.equal(sandbox.displayName(before, server), "旧名");

  const after = stateWithWorkers([{ id: "worker-a", displayName: "新名" }]);
  assert.equal(sandbox.displayName(after, server), "新名");
  assert.equal(sandbox.configIndex(after, server), 0);

  const unconfigured = stateWithWorkers([{ id: "worker-z" }]);
  assert.equal(sandbox.configIndex(unconfigured, server), 10000);
  assert.equal(sandbox.displayName(unconfigured, server), "回退名");
});

test("GPU server sorting keeps configured order without re-deriving aliases per comparison", () => {
  const sandbox = loadGpuLookup();
  const state = stateWithWorkers([
    { id: "worker-a", displayName: "A" },
    { id: "worker-b", displayName: "B" },
    { id: "worker-c", displayName: "C" },
  ]);
  const servers = [
    { serverId: "worker-c" },
    { serverId: "unknown-host" },
    { serverId: "worker-a" },
    { serverId: "worker-b" },
  ];

  const sorted = sandbox.sortServers(state, servers);
  assert.deepEqual(sorted.map((server) => server.serverId), ["worker-a", "worker-b", "worker-c", "unknown-host"]);
  assert.equal(sandbox.aliasCalls, servers.length);

  const resorted = sandbox.sortServers(state, servers);
  assert.deepEqual(resorted.map((server) => server.serverId), sorted.map((server) => server.serverId));
  assert.equal(sandbox.aliasCalls, servers.length);
});

test("Non-object GPU servers fall back without polluting the match cache", () => {
  const sandbox = loadGpuLookup();
  const state = stateWithWorkers([{ id: "worker-a", displayName: "A" }]);
  const match = sandbox.match(state, null);
  assert.equal(match.index, 10000);
  assert.equal(match.worker, null);
  assert.notEqual(sandbox.match(state, null), match);
});
