const assert = require("node:assert/strict");
const test = require("node:test");
const { SharedReadCoalescer } = require("../../dist/core/SharedReadCoalescer");
const { LatestSnapshotWriter } = require("../../dist/core/LatestSnapshotWriter");

test("coalesced reads preserve complete long identities and release settled entries", async () => {
  const reads = new SharedReadCoalescer();
  const prefix = "x".repeat(3000);
  const a = reads.run(prefix + "a", async () => "a");
  const b = reads.run(prefix + "b", async () => "b");
  assert.equal(reads.run(prefix + "a", async () => "wrong"), a);
  assert.equal(reads.has(prefix + "b"), true);
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.equal(reads.size, 0);
  await assert.rejects(reads.run("failure", async () => { throw new Error("read failed"); }), /read failed/);
  assert.equal(reads.size, 0);
});

test("coalescer capacity never retains overflow or confuses separate reads", async () => {
  const reads = new SharedReadCoalescer(1);
  let release;
  const first = reads.run("first", () => new Promise(resolve => { release = resolve; }));
  assert.equal(await reads.run("other", async () => "other"), "other");
  assert.equal(reads.size, 1);
  assert.equal(reads.has("other"), false);
  release("first"); await first;
  assert.equal(reads.size, 0);
});

test("1000 incident snapshots during a slow write retain and flush only the latest snapshot", async () => {
  let release;
  const written = [];
  const writer = new LatestSnapshotWriter(async value => {
    written.push(value);
    if (value === 0) await new Promise(resolve => { release = resolve; });
  });
  const draining = writer.enqueue(0);
  await new Promise(setImmediate);
  for (let i = 1; i <= 1000; i++) {
    assert.equal(writer.enqueue(i), draining);
    assert.equal(writer.pendingCount, 1);
  }
  assert.deepEqual(written, [0]);
  release(); await draining;
  assert.deepEqual(written, [0, 1000]);
  assert.equal(writer.pendingCount, 0);
});

test("a failed snapshot write settles and a later request can persist normally", async () => {
  const written = [];
  const writer = new LatestSnapshotWriter(async value => {
    if (value === "bad") throw new Error("storage unavailable");
    written.push(value);
  });
  await assert.rejects(writer.enqueue("bad"), /storage unavailable/);
  await writer.enqueue("good");
  assert.deepEqual(written, ["good"]);
});

test("Host incident persistence stays bounded during storage backpressure and does not post state", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript");
  const source = fs.readFileSync(require.resolve("../../src/extension/legacy.ts"), "utf8");
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
  const method = klass.members.find(node => node.name?.text === "recordPanelIncident").getText(ast);
  const context = vm.createContext({ LatestSnapshotWriter, Buffer, PANEL_INCIDENT_SLOT_MAX_BYTES: 65536,
    PANEL_INCIDENT_STORAGE_KEY: "incident", compactSensitiveText: (text, max) => String(text).slice(0, max),
    compactPanelRenderEvidence: () => null, compactPanelLayoutEvidence: () => null,
    compactPanelIncidentSlot: value => value, errorMessage: error => error.message });
  vm.runInContext(ts.transpileModule(`class Host {${method}}; this.host = new Host();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const host = context.host, saved = [];
  let release;
  Object.assign(host, { panelIncidentEvents: [], panelIncidentSlots: { latest: null, previous: null }, panelHostEventLoopSamples: [],
    postState: () => assert.fail("performance persistence must not trigger state updates"),
    context: { workspaceState: { update: async (_key, value) => {
      saved.push(value);
      if (saved.length === 1) await new Promise(resolve => { release = resolve; });
    } } },
  });
  host.recordPanelIncident("runtime", "0", true);
  await new Promise(setImmediate);
  const draining = host.panelIncidentWrite;
  for (let i = 1; i <= 200; i++) host.recordPanelIncident("runtime", String(i), true);
  assert.equal(host.panelIncidentWrite, draining);
  assert.equal(host.panelIncidentEvents.length, 64);
  assert.equal(host.panelIncidentWriter.pendingCount, 1);
  release(); await host.panelIncidentWrite;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].latest.message, "200");
  assert.equal(saved[1].previous.message, "199");
});
