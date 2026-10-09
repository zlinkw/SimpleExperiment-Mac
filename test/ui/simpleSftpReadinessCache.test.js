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

function loadReadiness() {
  const sandbox = {
    EMPTY_SIMPLE_SFTP_INTEGRATION: {},
    DEFAULT_SIMPLE_SFTP_READINESS: { ready: true, message: "" },
    SIMPLE_SFTP_GATED_COMMANDS: new Set(["prepareAgents", "runPlan"]),
    simpleSftpReadinessCacheSource: null,
    simpleSftpReadinessCacheValue: null,
    asArray: (value) => (Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value))),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("simpleSftpReadinessForState"),
    extractFunction("simpleSftpCommandDisableReason"),
    "this.readiness = simpleSftpReadinessForState;",
    "this.disableReason = simpleSftpCommandDisableReason;",
  ].join("\n"), sandbox);
  return sandbox;
}

function countingIntegration(fields) {
  let reads = 0;
  const item = {};
  Object.keys(fields).forEach((key) => {
    Object.defineProperty(item, key, {
      enumerable: true,
      get() { reads += 1; return fields[key]; },
    });
  });
  return { item, reads: () => reads };
}

test("SimpleSFTP readiness reuses the derived view while the integration object is unchanged", () => {
  const sandbox = loadReadiness();
  const source = countingIntegration({
    ready: false,
    installed: true,
    version: "0.1.3",
    missingCommands: ["simpleSftp.uploadDirectory"],
    legacyInstalled: false,
    legacyVersion: "",
    message: "SimpleSFTP 缺少编排命令",
  });
  const state = { integrations: { simpleSftp: source.item } };

  const first = sandbox.readiness(state);
  const firstReads = source.reads();
  assert.equal(first.ready, false);
  assert.equal(first.version, "0.1.3");
  assert.deepEqual(first.missingCommands, ["simpleSftp.uploadDirectory"]);
  assert.equal(first.message, "SimpleSFTP 缺少编排命令");

  assert.equal(sandbox.readiness(state), first);
  assert.equal(sandbox.readiness({ integrations: { simpleSftp: source.item } }), first);
  assert.equal(source.reads(), firstReads);
});

test("SimpleSFTP readiness invalidates when the integration payload is replaced", () => {
  const sandbox = loadReadiness();
  const blocked = { ready: false, message: "SimpleSFTP 未就绪" };
  const first = sandbox.readiness({ integrations: { simpleSftp: blocked } });
  assert.equal(first.ready, false);

  const repaired = { ready: true, installed: true, version: "0.1.4", message: "" };
  const second = sandbox.readiness({ integrations: { simpleSftp: repaired } });
  assert.notEqual(second, first);
  assert.equal(second.ready, true);
  assert.equal(second.version, "0.1.4");
  assert.equal(second.message, "配套 SimpleSFTP 未就绪。");
  assert.equal(sandbox.readiness({ integrations: { simpleSftp: blocked } }).ready, false);
});

test("Missing SimpleSFTP integration reuses the shared permissive default", () => {
  const sandbox = loadReadiness();
  const fallback = sandbox.readiness({});
  assert.equal(fallback, sandbox.DEFAULT_SIMPLE_SFTP_READINESS);
  assert.equal(fallback.ready, true);
  assert.equal(fallback.message, "");
  assert.equal(sandbox.readiness({ integrations: {} }), fallback);
  assert.equal(sandbox.readiness(undefined), fallback);
  assert.equal(sandbox.readiness({ integrations: { simpleSftp: "unavailable" } }), fallback);

  const blocked = sandbox.readiness({ integrations: { simpleSftp: { ready: false, message: "未安装" } } });
  assert.equal(blocked.ready, false);
  assert.equal(sandbox.readiness({}), fallback);
});

test("Gated command reasons stay consistent with the cached readiness view", () => {
  const sandbox = loadReadiness();
  const blockedState = { integrations: { simpleSftp: { ready: false, message: "未安装 SimpleSFTP" } } };
  assert.equal(sandbox.disableReason(blockedState, "prepareAgents"), "未安装 SimpleSFTP");
  assert.equal(sandbox.disableReason(blockedState, "runPlan"), "未安装 SimpleSFTP");
  assert.equal(sandbox.disableReason(blockedState, "snapshot"), "");
  assert.equal(sandbox.disableReason({ integrations: { simpleSftp: { ready: true } } }, "prepareAgents"), "");
  assert.equal(sandbox.disableReason({}, "prepareAgents"), "");
});
