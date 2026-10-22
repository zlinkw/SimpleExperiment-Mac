const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const { assessProjectTopology, normalizeTopologyMode } = require("../../dist/features/TopologyMode");

// Mac working-tree contract: worker_pool is the only executable mode (legacy mode values remain readable
// for stored settings, and the retired Hub never becomes an execution target).
test("topology mode is a project-scoped explicit setting", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const setting = pkg.contributes.configuration.properties["simpleExperimentMac.topologyMode"];
  assert.equal(setting.scope, "resource");
  assert.equal(setting.default, "worker_pool");
  assert.deepEqual(setting.enum, ["worker_pool"]);
});

test("legacy mode values resolve to worker_pool and validation depends only on enabled Workers", () => {
  for (const legacy of ["single_worker", "worker_pool", "hub_worker"]) {
    const one = assessProjectTopology(legacy, { hubConfigured: false, enabledWorkerIds: ["w1"] });
    assert.equal(one.mode, "worker_pool"); assert.equal(one.valid, true);
    const many = assessProjectTopology(legacy, { hubConfigured: false, enabledWorkerIds: ["w1", "w2"] });
    assert.equal(many.mode, "worker_pool"); assert.equal(many.valid, true);
  }
  // A configured Hub no longer invalidates anything: the endpoint layer already excludes it from targets.
  const hubLegacy = assessProjectTopology("hub_worker", { hubConfigured: true, enabledWorkerIds: ["w1"] });
  assert.equal(hubLegacy.mode, "worker_pool"); assert.equal(hubLegacy.valid, true); assert.equal(hubLegacy.hubAllowed, false);
  const none = assessProjectTopology("worker_pool", { hubConfigured: false, enabledWorkerIds: [] });
  assert.equal(none.valid, false);
  assert.match(none.issues.join(" "), /启用的 Worker/);
});

test("stored empty or legacy modes resolve to worker_pool without a confirmation round", () => {
  for (const stored of ["", "hub_worker", "single_worker"]) {
    const resolved = assessProjectTopology(stored, { hubConfigured: stored === "hub_worker", enabledWorkerIds: ["w1"] });
    assert.equal(resolved.mode, "worker_pool");
    assert.equal(resolved.source, "explicit");
    assert.equal(resolved.requiresConfirmation, false);
  }
});

test("worker inventory is unique and invalid configured values stay blocked", () => {
  const duplicate = assessProjectTopology("worker_pool", { hubConfigured: false, enabledWorkerIds: ["w1", "w1"] });
  assert.equal(duplicate.workerCount, 1);
  assert.equal(duplicate.valid, false);
  const invalid = assessProjectTopology("automatic", { hubConfigured: true, enabledWorkerCount: 2 });
  assert.equal(invalid.source, "invalid");
  assert.equal(invalid.valid, false);
  assert.equal(normalizeTopologyMode("automatic"), undefined);
});

test("topology assessment exposes per-Worker ownership and never allows the retired Hub", () => {
  for (const configured of ["single_worker", "worker_pool", "hub_worker"]) {
    const row = assessProjectTopology(configured, { hubConfigured: configured === "hub_worker", enabledWorkerCount: 1 });
    assert.equal(row.schedulerOwner, "各 Worker 独立调度");
    assert.equal(row.stateOwner, "Worker 本机项目目录");
    assert.equal(row.hubAllowed, false);
  }
});
