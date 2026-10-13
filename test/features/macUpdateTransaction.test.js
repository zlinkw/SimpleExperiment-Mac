const test = require("node:test");
const assert = require("node:assert/strict");
const { UpdateTransaction } = require("../../dist/mac/UpdateTransaction");
const { COMPONENT_IDS } = require("../../dist/mac/PreviewRelease");

function setup(options = {}) {
  const events = [], versions = { [COMPONENT_IDS[0]]: "0.1.1", [COMPONENT_IDS[1]]: "0.1.1", ...options.versions };
  const manifest = { protocolVersion: 1, releaseTag: "preview-v0.1.2", components: COMPONENT_IDS.map(extensionId => ({ extensionId, version: "0.1.2" })) };
  let journal = options.journal;
  const io = {
    readJournal: () => journal, saveJournal: async value => { journal = JSON.parse(JSON.stringify(value)); events.push(`save:${value.status}`); },
    currentVersion: id => versions[id], beginGate: async () => events.push("gate"), waitForTransfers: async signal => { events.push("wait"); await options.wait?.(signal); }, endGate: async () => events.push("ungate"),
    downloadAndVerify: async item => { events.push(`download:${item.extensionId}`); if (options.downloadFailure === item.extensionId) throw Error("hash mismatch"); return item.extensionId; },
    verifyPrepared: async file => events.push(`verify:${file}`), install: async file => { events.push(`install:${file}`); if (options.installFailure === file) throw Error("install failed"); },
    reload: async () => events.push("reload"),
  };
  return { engine: new UpdateTransaction(io), events, plan: { manifest, pending: manifest.components }, journal: () => journal };
}
test("blocks new work and drains transfers then verifies ALL packages before ordered install and reload", async () => {
  const f = setup(); await f.engine.install(f.plan);
  const sftp = f.events.indexOf(`install:${COMPONENT_IDS[0]}`), experiment = f.events.indexOf(`install:${COMPONENT_IDS[1]}`);
  assert.ok(f.events.indexOf("gate") < f.events.indexOf("wait"));
  assert.ok(f.events.indexOf(`download:${COMPONENT_IDS[1]}`) < sftp); assert.ok(sftp < experiment); assert.ok(experiment < f.events.indexOf("reload"));
  assert.equal(f.journal().status, "reload_required"); assert.ok(!f.events.includes("ungate"));
});

test("a failed first installer receipt preserves the gate even with zero completed components", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.plan), /install failed/);
  assert.equal(f.journal().installationRequested, true); assert.deepEqual(f.journal().completed, []);
  assert.ok(!f.events.includes("ungate")); assert.ok(!f.events.includes(`install:${COMPONENT_IDS[1]}`));
});
test("a partial or uncertain update cannot replace its frozen batch or same-tag manifest", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.plan));
  for (const changeTag of [true, false]) {
    const retry = setup({ journal: f.journal() });
    if (changeTag) retry.plan.manifest.releaseTag = "preview-v0.1.3";
    else retry.plan.manifest.components[0].sha256 = "b".repeat(64);
    await assert.rejects(retry.engine.install(retry.plan), /不能替换更新清单/);
    assert.equal(retry.events.length, 0);
  }
});
test("caller mutation during transfer wait cannot change the validated update snapshot", async () => {
  let release; const f = setup({ wait: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.engine.install(f.plan); await new Promise(resolve => setImmediate(resolve));
  f.plan.manifest.components[0].version = "9.0.0"; f.plan.manifest.releaseTag = "preview-v9.0.0";
  release(); await pending;
  assert.equal(f.journal().manifest.releaseTag, "preview-v0.1.2"); assert.equal(f.journal().manifest.components[0].version, "0.1.2");
});
test("cancelling update wait releases admission before any download or installation", async () => {
  const controller = new AbortController();
  const f = setup({ wait: signal => { controller.abort(Error("cancel update wait")); signal.throwIfAborted(); } });
  await assert.rejects(f.engine.install(f.plan, controller.signal), /cancel update wait/);
  assert.ok(f.events.includes("ungate"));
  assert.equal(f.journal().installationRequested, false); assert.ok(!f.events.some(item => item.startsWith("download:")));
});
test("a tampered persisted fingerprint cannot resume an installer", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.plan));
  const journal = structuredClone(f.journal()); journal.manifest.components[0].version = "9.0.0";
  const retry = setup({ journal }); await assert.rejects(retry.engine.install(retry.plan), /清单身份发生变化/);
  assert.equal(retry.events.length, 0);
});
test("verification failure installs nothing and releases business gate", async () => {
  const f = setup({ downloadFailure: COMPONENT_IDS[1] }); await assert.rejects(f.engine.install(f.plan), /hash mismatch/);
  assert.ok(!f.events.some(item => item.startsWith("install:"))); assert.ok(f.events.includes("ungate"));
});
test("partial success persists receipts and reload resume only installs the remaining component", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[1] }); await assert.rejects(f.engine.install(f.plan), /已完成/);
  assert.deepEqual(f.journal().completed, [COMPONENT_IDS[0]]); assert.ok(!f.events.includes("ungate"));
  const retry = setup({ journal: f.journal(), versions: { [COMPONENT_IDS[0]]: "0.1.2" } }); await retry.engine.install(retry.plan);
  assert.ok(!retry.events.includes(`install:${COMPONENT_IDS[0]}`)); assert.ok(!retry.events.includes(`download:${COMPONENT_IDS[0]}`)); assert.deepEqual(retry.journal().completed, [...COMPONENT_IDS]);
});
test("double clicks share one transaction while existing local transfers finish", async () => {
  let resume; const wait = new Promise(resolve => { resume = resolve; }); const f = setup({ wait: () => wait });
  const first = f.engine.install(f.plan), second = f.engine.install(f.plan); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(f.events.includes("wait")); assert.ok(!f.events.some(item => item.startsWith("download:")));
  resume(); await first; assert.equal(f.events.filter(item => item.startsWith("install:")).length, 2);
});
test("a second download failure after partial installation retains the business gate and receipts", async () => {
  const first = setup({ installFailure: COMPONENT_IDS[1] });
  await assert.rejects(first.engine.install(first.plan), /install failed/);
  const retry = setup({ journal: first.journal(), downloadFailure: COMPONENT_IDS[1], versions: { [COMPONENT_IDS[0]]: "0.1.2" } });
  await assert.rejects(retry.engine.install(retry.plan), /hash mismatch/);
  assert.deepEqual(retry.journal().completed, [COMPONENT_IDS[0]]);
  assert.ok(!retry.events.includes("ungate"));
  assert.ok(!retry.events.includes(`download:${COMPONENT_IDS[0]}`));
});
test("same/newer versions skip and a crash before receipt is reconciled from installed versions", async () => {
  const f = setup({ versions: { [COMPONENT_IDS[0]]: "0.2.0", [COMPONENT_IDS[1]]: "0.1.2" } }); await f.engine.install(f.plan); assert.equal(f.events.length, 0);
  const retry = setup({ journal: { manifest: f.plan.manifest, completed: [], status: "installing" }, versions: { [COMPONENT_IDS[0]]: "0.1.2" } }); await retry.engine.install(retry.plan);
  assert.ok(!retry.events.includes(`install:${COMPONENT_IDS[0]}`));
});
