const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { OperationLedger } = require("../dist/diagnostics/OperationLedger.js");
const { checkClusterConsistency } = require("../dist/diagnostics/ConsistencyChecker.js");
const { mergeExperimentTracesStable, schedulerRowStatusRank } = require("../dist/cluster/StateMerge.js");
const { readJsonState, writeJsonState } = require("../dist/state/StateStore.js");
const { FakeRemoteCommandRunner } = require("../dist/test/fakes/FakeRemoteCommandRunner.js");
const { fakeExperiment, fakeServer } = require("../dist/test/fakes/FakeClusterState.js");

test("operation ledger records opId and stale_dropped", () => {
  const ledger = new OperationLedger();
  const op = ledger.begin("scan_gpu", "auto", { seq: 1, serverIds: ["w1"] });
  assert.match(op.opId, /^scan_gpu-/);
  ledger.finish(op, "stale_dropped");
  assert.equal(ledger.recent()[0].status, "stale_dropped");
});

test("merge keeps completed/archive state over older unknown", () => {
  const prev = [fakeExperiment({ archive_key: "a", hub_archive_state: "archived", archive_status_text: "3 端已归档" })];
  const incoming = [fakeExperiment({ archive_key: "a", hub_archive_state: "unknown", archive_status_text: "Hub 状态刷新中" })];
  const merged = mergeExperimentTracesStable(prev, incoming);
  assert.equal(merged[0].hub_archive_state, "archived");
  assert.equal(schedulerRowStatusRank("completed") > schedulerRowStatusRank("running"), true);
});

test("state store corrupt json returns lastKnownGood and atomic write validates schema", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-state-"));
  const file = path.join(dir, "state.json");
  const validate = (value) => value && value.schemaVersion === 1 && Array.isArray(value.items);
  await writeJsonState(file, { items: [] }, 1, validate);
  let read = await readJsonState(file, validate, (value) => ({ schemaVersion: 1, items: value.items || [] }));
  assert.equal(read.ok, true);
  await fs.writeFile(file, "{broken", "utf8");
  read = await readJsonState(file, validate, (value) => value, { schemaVersion: 1, items: ["last"] });
  assert.equal(read.ok, false);
  assert.deepEqual(read.lastKnownGood.items, ["last"]);
});

test("fake remote runner simulates ssh failure and timeout", async () => {
  const runner = new FakeRemoteCommandRunner()
    .on("nvidia-smi", { code: 255, stdout: "", stderr: "ssh_failed" })
    .on("sleep", { code: 0, stdout: "late", stderr: "", delayMs: 2000 });
  assert.equal((await runner.run("w1", "nvidia-smi", { timeoutMs: 1000 })).stderr, "ssh_failed");
  assert.equal((await runner.run("w1", "sleep 10", { timeoutMs: 10 })).stderr, "timeout");
  assert.equal(runner.calls.length, 2);
});

test("consistency checker detects tombstone restore, source mismatch, key mismatch", () => {
  const issues = checkClusterConsistency({
    traces: [fakeExperiment({ archive_key: "deleted-key", worker_id: "ssh-config:missing" })],
    records: [{ archiveKey: "registry-key", state: "archived", manifest: { archiveKey: "manifest-key" } }],
    tombstones: new Set(["deleted-key"]),
    servers: [fakeServer("w1")],
    serverIdentityCandidates: (server) => [String(server.id).toLowerCase(), String(server.host).toLowerCase()],
  });
  assert.equal(issues.some((issue) => issue.kind === "tombstone_visible"), true);
  assert.equal(issues.some((issue) => issue.kind === "source_server_unmatched"), true);
  assert.equal(issues.some((issue) => issue.kind === "archive_key_mismatch"), true);
});