const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "..", "..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("worker-only server setup does not require Hub session or project root", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("serverSetupMissingItems")}\nthis.check = serverSetupMissingItems;`, sandbox);
  const missing = sandbox.check({ savedSessionPath: "", agentProjectDir: "", workerTunnels: [{ id: "w1", savedSessionPath: "w1.xsh", agentProjectDir: "/srv/project" }] }, false);
  assert.equal(missing.length, 0);
});

test("worker-only bootstrap readiness ignores offline Hub and Hub dependency data", () => {
  const sandbox = { HUB_READY_STATUSES: new Set(["ok", "agent_ok", "file_api_unavailable"]) };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("projectBootstrapEndpointReadiness")}\nthis.check = projectBootstrapEndpointReadiness;`, sandbox);
  const readiness = sandbox.check({
    hubRequired: false,
    hubStatus: "local_port_closed",
    hubSchedulerDependencies: { ok: false, message: "Hub unavailable" },
    workers: [{ label: "Worker A", status: "ok", schedulerDependencies: { ok: true } }],
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.hubRequired, false);
  assert.equal(readiness.missing.length, 0);
});

test("frontend readiness derives Hub requirements from the selected topology", () => {
  assert.match(panel, /const hubRequired = topology\.mode \? topology\.mode === "hub_worker" : true/);
  assert.match(panel, /const hubReady = !hubRequired \|\| HUB_OPERATION_READY_STATUS_TOKENS/);
  assert.match(panel, /const restartRequired = hubRequired && hubStatus === "agent_restart_required"/);
  assert.match(panel, /let versionMismatch = hubRequired && hubStatus === "agent_version_mismatch"/);
  assert.match(panel, /let projectMismatch = hubRequired && hubStatus === "agent_project_mismatch"/);
  assert.match(panel, /const hubReady = !hubRequired \|\| syncStatusOk\(sync\.hub\)/);
  assert.match(extension, /serverSetupMissingItems\(this\.setupConfig, hubRequired\)/);
  assert.match(extension, /projectOnboardingCompletedFromCodeSync\(this\.lastCodeSyncState, topology\.hubAllowed\)/);
  assert.match(extension, /const scopedRegistry = hubAllowed \? registry : \{[\s\S]*endpoints: registry\.endpoints\.filter\(\(endpoint\) => endpoint\.role !== "hub_control"\)/);
});
