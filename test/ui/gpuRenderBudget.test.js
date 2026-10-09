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

function loadBudget(visibleIds = []) {
  const sandbox = {
    ownerChecks: 0,
    rowBudgetChecks: [],
    cleanEndpointId(value) { return String(value || "").trim().toLowerCase(); },
    budgetGpuServersForRender(servers) {
      const allowed = new Set(visibleIds);
      return servers.filter((server) => allowed.has(server.serverId));
    },
    budgetGpuRowsForRender(rows) {
      sandbox.rowBudgetChecks.push(rows);
      return { visibleRows: rows.slice(0, 1), omittedCount: Math.max(0, rows.length - 1) };
    },
    isMyGpu(gpu) {
      sandbox.ownerChecks += 1;
      return Boolean(gpu.mine);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("gpuRenderBudget")}\nthis.check = gpuRenderBudget;`, sandbox);
  return sandbox;
}

test("GPU render budget derives all counters and omissions in one server pass", () => {
  const sandbox = loadBudget(["server-a", "server-c"]);
  const servers = [
    { serverId: "server-a", gpuRows: [{ busy: true, mine: true }, { busy: false, mine: false }] },
    { serverId: "server-b", gpuRows: [{ busy: true, mine: false }, { busy: false, mine: true }] },
    { serverId: "server-c", gpuRows: [{ busy: true, mine: false }] },
  ];
  const result = sandbox.check(servers, { currentUser: "alice" });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    visibleServers: [servers[0], servers[2]],
    gpuCount: 5,
    busyCount: 3,
    mineCount: 2,
    omittedServerCount: 1,
    omittedGpuRowCount: 3,
  });
  assert.equal(sandbox.ownerChecks, 5);
  assert.deepEqual(Array.from(sandbox.rowBudgetChecks), [servers[0].gpuRows, servers[2].gpuRows]);
});

test("GPU render budget keeps empty snapshots stable", () => {
  const sandbox = loadBudget([]);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.check([], {}))), {
    visibleServers: [],
    gpuCount: 0,
    busyCount: 0,
    mineCount: 0,
    omittedServerCount: 0,
    omittedGpuRowCount: 0,
  });
  assert.equal(sandbox.ownerChecks, 0);
  assert.equal(sandbox.rowBudgetChecks.length, 0);
});

test("GPU render budget avoids filter, map and reduce counter arrays", () => {
  const source = extractFunction("gpuRenderBudget");
  assert.doesNotMatch(source, /\.(?:filter|map|reduce)\s*\(/);
  assert.match(source, /for \(const server of servers\)/);
  assert.match(source, /for \(const gpu of rows\)/);
});
