const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    Uri: { file: value => ({ fsPath: value }) },
  } : originalLoad.call(this, name, ...args);
};
const prototype = require("../../dist/extension/legacy.js").RealtimeTunnelPanelProvider.prototype;
Module._load = originalLoad;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-merge-preflight-"));
  const calls = [];
  const targets = [{ id: "first" }, { id: "second" }];
  const files = ["simple_cluster/results/legacy/raw.csv", "simple_cluster/results/by_plan/new/datasets/data/final.csv"];
  const host = Object.assign(Object.create(prototype), {
    context: { globalStorageUri: { fsPath: root } }, setupConfig: { workerTunnels: targets },
    sftpServerOptions: target => ({ id: target.id }),
    simpleSftpApiCall: async (method, params) => {
      calls.push({ method, params });
      return { files: Object.fromEntries(files.map(file => [file, { sha256: "a".repeat(64), size: 10, modifiedAtMs: 1 }])) };
    },
    loadPlanSyncLedger: async () => ({ schemaVersion: 2, entries: {} }),
    loadDistributedQueue: async () => ({ plans: [] }),
  });
  return { root, host, calls, targets, files };
}

test("old and dataset-scoped result paths share one inventory per Worker", async () => {
  const { root, host, calls, targets, files } = fixture();
  const result = await host.mergeLatestWorkerVersions(root, targets, files, ".");
  assert.deepEqual(result.completed, []);
  assert.equal(calls.length, targets.length);
  for (const { method, params } of calls) {
    assert.equal(method, "sync.projectInventory");
    assert.equal(params.relativePath, ".");
    assert.deepEqual(params.scopePaths, files);
  }
  assert.equal(host.syncScopeMutationInFlight, false);
});

test("empty bounded metrics inventory never scans the project root", async () => {
  const { root, host, calls, targets } = fixture();
  await host.mergeLatestWorkerVersions(root, targets, [], ".", () => {}, { metricsOnly: true });
  assert.equal(calls.length, 0);
});

test("cancelled metric preflight never starts inventory or leaves a sync lock", async () => {
  const { root, host, calls, targets, files } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.mergeLatestWorkerVersions(root, targets, files, ".", () => {}, { metricsOnly: true, signal: controller.signal }), /取消/);
  assert.equal(calls.length, 0);
  assert.notEqual(host.syncScopeMutationInFlight, true);
});

test("inventory failure blocks publication and clears the sync lock", async () => {
  const { root, host, targets, files } = fixture();
  host.simpleSftpApiCall = async () => { throw new Error("inventory disconnected"); };
  await assert.rejects(host.mergeLatestWorkerVersions(root, targets, files, "."), /清单校验失败.*inventory disconnected/);
  assert.equal(host.syncScopeMutationInFlight, false);
});

test("cancelling in-flight inventory reaches every Worker and releases the lock", async () => {
  const { root, host, targets, files } = fixture();
  const controller = new AbortController();
  let started = 0;
  host.simpleSftpApiCall = async (_method, params) => {
    assert.equal(params.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      params.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      if (++started === targets.length) controller.abort();
    });
  };
  await assert.rejects(host.mergeLatestWorkerVersions(root, targets, files, ".", () => {}, { metricsOnly: true, signal: controller.signal }), /取消/);
  assert.equal(started, targets.length);
  assert.equal(host.syncScopeMutationInFlight, false);
});
