const test = require("node:test");
const assert = require("node:assert/strict");
// Mac paired-update transaction, aligned to the Windows-authoritative updates/UpdateTransaction
// (frozen Windows pairedUpdateGate/pairedUpdateTransaction call chain): the durable unit is the
// component fingerprint, receipts reconcile from installed versions, and the gate only opens once
// an installer was actually requested or a mixed journal exists.
const { UpdateTransaction } = require("../../dist/mac/UpdateTransaction");
const { COMPONENT_IDS } = require("../../dist/mac/PreviewRelease");

function setup(options = {}) {
  const events = [], versions = { [COMPONENT_IDS[0]]: "0.1.1", [COMPONENT_IDS[1]]: "0.1.1", ...options.versions };
  const components = COMPONENT_IDS.map(id => ({ id, latestVersion: "0.1.2", vsix: { digest: "sha256:" + "a".repeat(64) } }));
  let journal = options.journal;
  const io = {
    readJournal: () => journal, saveJournal: async value => { journal = structuredClone(value); events.push(`save:${value.status}`); },
    currentVersion: id => versions[id], beginGate: async () => events.push("gate"),
    waitForTransfers: async signal => { events.push("wait"); await options.wait?.(signal); }, endGate: async () => events.push("ungate"),
    prepare: async item => { events.push(`download:${item.id}`); if (options.downloadFailure === item.id) throw Error("hash mismatch"); return item.id; },
    verify: async file => events.push(`verify:${file}`),
    install: async file => { events.push(`install:${file}`); if (options.installFailure === file) throw Error("install failed"); versions[file] = "0.1.2"; },
    reload: async () => events.push("reload"),
  };
  return { engine: new UpdateTransaction(io), events, components, journal: () => journal };
}

test("blocks new work and drains transfers then verifies ALL packages before ordered install and reload", async () => {
  const f = setup(); await f.engine.install(f.components);
  const sftp = f.events.indexOf(`install:${COMPONENT_IDS[0]}`), experiment = f.events.indexOf(`install:${COMPONENT_IDS[1]}`);
  assert.ok(f.events.indexOf("gate") < f.events.indexOf("wait"));
  assert.ok(f.events.indexOf(`download:${COMPONENT_IDS[1]}`) < sftp); assert.ok(sftp < experiment); assert.ok(experiment < f.events.indexOf("reload"));
  assert.equal(f.journal().status, "reload_required"); assert.ok(!f.events.includes("ungate"));
});

test("a failed first installer receipt preserves the gate even with zero completed components", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.components), /install failed/);
  assert.equal(f.journal().installationRequested, true); assert.deepEqual(f.journal().completed, []);
  assert.ok(!f.events.includes("ungate")); assert.ok(!f.events.includes(`install:${COMPONENT_IDS[1]}`));
});

test("a partial update cannot replace its frozen component batch, but a same-fingerprint tag change may retry", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.components));
  { const retry = setup({ journal: f.journal() }); retry.components[0].vsix.digest = "sha256:" + "b".repeat(64);
    await assert.rejects(retry.engine.install(retry.components), /不能替换已确认的更新批次/); assert.equal(retry.events.length, 0); }
  { const retry = setup({ journal: f.journal() }); retry.components[1].latestVersion = "0.2.0";
    await assert.rejects(retry.engine.install(retry.components), /不能替换已确认的更新批次/); assert.equal(retry.events.length, 0); }
  // Current Windows contract: only the component fingerprint freezes the batch, not any surrounding tag.
  const retry = setup({ journal: f.journal() }); await retry.engine.install(retry.components);
  assert.ok(retry.events.includes("gate"));
});

test("caller mutation during transfer wait cannot change the validated update snapshot", async () => {
  let release; const f = setup({ wait: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.engine.install(f.components); await new Promise(resolve => setImmediate(resolve));
  f.components[0].latestVersion = "9.0.0"; f.components[0].id = "mutated";
  release(); await pending;
  assert.equal(f.journal().components[0].latestVersion, "0.1.2"); assert.equal(f.journal().components[0].id, COMPONENT_IDS[0]);
});

test("cancelling update wait releases admission before any download or installation", async () => {
  const controller = new AbortController();
  const f = setup({ wait: signal => { controller.abort(Error("cancel update wait")); signal.throwIfAborted(); } });
  await assert.rejects(f.engine.install(f.components, controller.signal), /cancel update wait/);
  assert.ok(f.events.includes("ungate"));
  assert.equal(f.journal().installationRequested, false); assert.ok(!f.events.some(item => item.startsWith("download:")));
});

test("a tampered persisted fingerprint cannot resume an installer", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[0] }); await assert.rejects(f.engine.install(f.components));
  const journal = structuredClone(f.journal()); journal.components[0].latestVersion = "9.0.0"; journal.fingerprint = "c".repeat(64);
  const retry = setup({ journal }); await assert.rejects(retry.engine.install(f.components), /不能替换已确认的更新批次/);
  assert.equal(retry.events.length, 0);
});

test("verification failure installs nothing and releases business gate", async () => {
  const f = setup({ downloadFailure: COMPONENT_IDS[1] }); await assert.rejects(f.engine.install(f.components), /hash mismatch/);
  assert.ok(!f.events.some(item => item.startsWith("install:"))); assert.ok(f.events.includes("ungate"));
});

test("partial success persists receipts and reload resume only installs the remaining component", async () => {
  const f = setup({ installFailure: COMPONENT_IDS[1] }); await assert.rejects(f.engine.install(f.components), /已完成/);
  assert.deepEqual(f.journal().completed, [COMPONENT_IDS[0]]); assert.ok(!f.events.includes("ungate"));
  const retry = setup({ journal: f.journal(), versions: { [COMPONENT_IDS[0]]: "0.1.2" } }); await retry.engine.install(f.components);
  assert.ok(!retry.events.includes(`install:${COMPONENT_IDS[0]}`)); assert.ok(!retry.events.includes(`download:${COMPONENT_IDS[0]}`));
  assert.deepEqual(retry.journal().completed, [...COMPONENT_IDS]);
});

test("double clicks share one transaction while existing local transfers finish", async () => {
  let resume; const wait = new Promise(resolve => { resume = resolve; }); const f = setup({ wait: () => wait });
  const first = f.engine.install(f.components), second = f.engine.install(f.components); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(f.events.includes("wait")); assert.ok(!f.events.some(item => item.startsWith("download:")));
  resume(); await first; assert.equal(f.events.filter(item => item.startsWith("install:")).length, 2);
});

test("a second download failure after partial installation retains the business gate and receipts", async () => {
  const first = setup({ installFailure: COMPONENT_IDS[1] });
  await assert.rejects(first.engine.install(first.components), /install failed/);
  const retry = setup({ journal: first.journal(), downloadFailure: COMPONENT_IDS[1], versions: { [COMPONENT_IDS[0]]: "0.1.2" } });
  await assert.rejects(retry.engine.install(retry.components), /hash mismatch/);
  assert.deepEqual(retry.journal().completed, [COMPONENT_IDS[0]]);
  assert.ok(!retry.events.includes("ungate"));
  assert.ok(!retry.events.includes(`download:${COMPONENT_IDS[0]}`));
});

test("same/newer versions skip and a crash before receipt is reconciled from installed versions", async () => {
  const f = setup({ versions: { [COMPONENT_IDS[0]]: "0.2.0", [COMPONENT_IDS[1]]: "0.1.2" } }); await f.engine.install(f.components); assert.equal(f.events.length, 0);
  const failed = setup({ installFailure: COMPONENT_IDS[1] }); await assert.rejects(failed.engine.install(failed.components));
  const retry = setup({ journal: failed.journal(), versions: { [COMPONENT_IDS[0]]: "0.1.2" } }); await retry.engine.install(retry.components);
  assert.ok(!retry.events.includes(`install:${COMPONENT_IDS[0]}`));
});

test("a persisted receipt alone cannot hide a missing installation", async () => {
  const first = setup({ installFailure: COMPONENT_IDS[1] }); await assert.rejects(first.engine.install(first.components));
  const stale = setup({ journal: first.journal() }); await stale.engine.install(stale.components);
  assert.ok(stale.events.includes(`install:${COMPONENT_IDS[0]}`), "persisted receipt alone cannot hide a missing installation");
});
