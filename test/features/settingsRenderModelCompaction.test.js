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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("settings has a dedicated dependency key and bounded render model", () => {
  const dependency = extractFunction("sectionDependencyKey");
  const renderModel = extractFunction("sectionRenderModel");
  const settingsModel = extractFunction("settingsRenderModel");

  assert.match(dependency, /section === "settings"[\s\S]*data\.topology[\s\S]*data\.schedulerConfig[\s\S]*data\.resultOutputConfig/);
  assert.match(renderModel, /if \(section === "settings"\) return settingsRenderModel\(data\)/);
  assert.match(renderModel, /if \(section === "servers"\)[\s\S]*schedulerConfig:[\s\S]*workerTelemetryStatus:/);
  for (const field of ["schedulerStates", "experimentTraces", "logs", "operations", "resultsSummary"]) {
    assert.doesNotMatch(settingsModel, new RegExp(`data\\.${field}`));
  }
});

test("settings model changes for topology scheduler and result directory updates", () => {
  const sandbox = {
    SECTION_SIGNATURE_ROW_LIMIT: 80,
    compactSettingsTopologyForSignature: (value) => value,
    compactSetupForSignature: (value) => value,
    compactAgentDestinationsForSignature: (value) => value,
    compactXshellSessionsForSignature: (value) => value,
    compactRecordForSignature(value, keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(value || {}, key)).map((key) => [key, value[key]]));
    },
    compactRowsForSignature: (value) => value,
    compactObjectMapForSignature: (value) => value,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("settingsAdapterRulesSignature")}\n${extractFunction("settingsRenderModel")}\nthis.model = settingsRenderModel;`, sandbox);
  const base = {
    topology: { mode: "single_worker" },
    schedulerConfig: { pollSeconds: 60 },
    resultOutputConfig: { csvDirectory: "experiments/results" },
    schedulerStates: Array.from({ length: 1000 }, (_, index) => ({ index })),
    experimentTraces: Array.from({ length: 1000 }, (_, index) => ({ index })),
    logs: "large-log",
  };
  const model = plain(sandbox.model(base));

  assert.equal(model.schedulerStates, undefined);
  assert.equal(model.experimentTraces, undefined);
  assert.notEqual(JSON.stringify(model), JSON.stringify(plain(sandbox.model({ ...base, topology: { mode: "worker_pool" } }))));
  assert.notEqual(JSON.stringify(model), JSON.stringify(plain(sandbox.model({ ...base, schedulerConfig: { pollSeconds: 90 } }))));
  assert.notEqual(JSON.stringify(model), JSON.stringify(plain(sandbox.model({ ...base, resultOutputConfig: { csvDirectory: "results/final" } }))));
  for (const change of [
    { schedulerConfig: { dispatchMode: "server_prequeue" } },
    { remoteRootPolicy: { allowedRoots: ["/srv/projects"] } },
    { pluginUpdate: { status: "update_available" } },
    { resultOutputConfig: { adapterRules: { primaryMetric: "F1" } } },
    { detectedProject: { adapterRules: { candidateCsv: ["metrics.csv"] } } },
    { sectionRevisions: { settings: 3 } },
  ]) assert.notEqual(JSON.stringify(model), JSON.stringify(plain(sandbox.model({ ...base, ...change }))));
});

test("settings setup signature retains every editable Hub and Worker field", () => {
  const sandbox = loadCompactionSandbox();
  const setup = {
    hubDisplayName: "Hub A",
    hubHost: "hub.example",
    transferHost: "sftp.example",
    hubUser: "alice",
    condaEnv: "research",
    sshConfigAlias: "hub-alias",
    agentProjectDir: "/srv/projects",
    savedSessionPath: "C:/sessions/hub.xsh",
    savedSessionForwardIndex: 3,
    localForwardPort: 18765,
    remoteAgentPort: 18765,
    workerTunnels: [{
      id: "worker-a",
      transferHost: "worker-sftp.example",
      workerUser: "bob",
      condaEnv: "worker-env",
      sshConfigAlias: "worker-alias",
      remoteTelemetryPort: 18766,
      savedSessionForwardIndex: 4,
    }],
  };
  const compacted = plain(sandbox.compactSetup(setup));

  assert.equal(compacted.transferHost, setup.transferHost);
  assert.equal(compacted.savedSessionForwardIndex, 3);
  assert.equal(compacted.remoteAgentPort, 18765);
  assert.equal(compacted.workers.rows[0].workerUser, "bob");
  assert.equal(compacted.workers.rows[0].remoteTelemetryPort, 18766);
  assert.equal(compacted.workers.rows[0].savedSessionForwardIndex, 4);
});

test("Xshell wrapper counts sessions and forwards remain bounded and render-sensitive", () => {
  const sandbox = loadCompactionSandbox();
  const sessions = Array.from({ length: 100 }, (_, index) => ({
    name: `session-${index}`,
    filePath: `C:/sessions/${index}.xsh`,
    host: `host-${index}`,
    forwards: Array.from({ length: 100 }, (_, forwardIndex) => ({
      index: forwardIndex,
      localPort: 18000 + forwardIndex,
      remoteHost: "127.0.0.1",
      remotePort: 18765 + forwardIndex,
    })),
  }));
  const compacted = plain(sandbox.compactXshell({ totalCount: 120, visibleCount: 100, omittedCount: 20, sessions }));

  assert.equal(compacted.totalCount, 120);
  assert.equal(compacted.visibleCount, 100);
  assert.equal(compacted.omittedCount, 20);
  assert.equal(compacted.sessions.count, 100);
  assert.equal(compacted.sessions.rows.length, 80);
  assert.equal(compacted.sessions.rows[0].forwards.count, 100);
  assert.equal(compacted.sessions.rows[0].forwards.rows.length, 80);
  assert.equal(compacted.sessions.rows[0].forwards.rows[0].remotePort, 18765);
});

function loadCompactionSandbox() {
  const sandbox = {
    SECTION_SIGNATURE_ROW_LIMIT: 80,
    SIGNATURE_COMPACTION_VARIANT_LIMIT: 8,
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    compactRowsForSignatureCache: new WeakMap(),
    asArray(value) {
      return Array.isArray(value) ? value : [];
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("compactRecordForSignature"),
    extractFunction("compactRowsForSignature"),
    extractFunction("compactSetupForSignature"),
    extractFunction("compactXshellSessionForSignature"),
    extractFunction("compactXshellSessionsForSignature"),
    "this.compactSetup = compactSetupForSignature;",
    "this.compactXshell = compactXshellSessionsForSignature;",
  ].join("\n"), sandbox);
  return sandbox;
}
