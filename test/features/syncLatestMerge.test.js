const assert = require("node:assert/strict");
const test = require("node:test");
const { planLatestWorkerMerge } = require("../../dist/features/SyncLatestMerge.js");
const { buildScopeStatuses } = require("../../dist/features/SyncScopeStatus.js");

test("latest Worker merge chooses per-file Plan or timestamp source and skips ambiguity", () => {
  const statuses = {
    "results/plan.csv": { state: "different", detail: "", versions: {
      w2: { sha256: "new", latest: "plan", modifiedAtMs: 100 },
      w3: { sha256: "old", modifiedAtMs: 200 },
      w5: { sha256: "new", modifiedAtMs: 50 },
    } },
    "results/weight.bin": { state: "different", detail: "", versions: {
      w2: { sha256: "old", modifiedAtMs: 100 },
      w3: { sha256: "new", latest: "candidate", modifiedAtMs: 200 },
    } },
    "results/ambiguous.csv": { state: "different", detail: "", versions: {
      w2: { sha256: "a", modifiedAtMs: 100 }, w3: { sha256: "b", modifiedAtMs: 100 },
    } },
    "results/unstable.csv": { state: "unknown", detail: "", unverified: true, versions: {} },
  };
  const result = planLatestWorkerMerge(statuses, ["w2", "w3", "w5"]);
  assert.deepEqual(result.items, [
    { path: "results/plan.csv", sourceId: "w2", destinationIds: ["w3"] },
    { path: "results/weight.bin", sourceId: "w3", destinationIds: ["w2", "w5"] },
  ]);
  assert.match(result.skipped.join(" "), /ambiguous\.csv/);
  assert.match(result.skipped.join(" "), /unstable\.csv/);
});

test("latest Worker merge uses distributed publication source for a conflicting preview", () => {
  const file = "simple_cluster/results/distributed_preview.json";
  const inventory = { local: {}, workers: {
    w2: { [file]: { sha256: "a", size: 1, modifiedAtMs: 100 } },
    w3: { [file]: { sha256: "b", size: 1, modifiedAtMs: 100 } },
    w5: { [file]: { sha256: "c", size: 1, modifiedAtMs: 100 } },
  } };
  const statuses = buildScopeStatuses(inventory, "server-server", ["."], new Set(),
    { schemaVersion: 2, entries: {} }, new Set(), {}, { [file]: "w3" });
  assert.deepEqual(planLatestWorkerMerge(statuses, ["w2", "w3", "w5"]), {
    items: [{ path: file, sourceId: "w3", destinationIds: ["w2", "w5"] }], skipped: [],
  });
});
