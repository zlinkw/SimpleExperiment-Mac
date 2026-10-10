const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadReadiness() {
  const constantsStart = source.indexOf("const SIMPLE_SFTP_EXTENSION_ID");
  const constantsEnd = source.indexOf("const defaultUiSectionOrder", constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
  const sandbox = { vscode: { extensions: {} } };
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(constantsStart, constantsEnd) +
      extractFunction("legacySftpInstallationState") +
      extractFunction("simpleSftpIntegrationReadiness") +
      "\nthis.readiness = simpleSftpIntegrationReadiness;",
    sandbox
  );
  return sandbox.readiness;
}

test("SimpleSFTP integration readiness validates the paired command ABI", () => {
  const readiness = loadReadiness();
  const missing = readiness({ getExtension() { return undefined; } });
  assert.equal(missing.ready, false);
  assert.equal(missing.installed, false);
  assert.match(missing.message, /同一 preview Release/);
  assert.match(missing.message, /先安装 SimpleSFTP Mac VSIX/);
  assert.doesNotMatch(missing.message, /\.ps1|Windows/);

  const ready = readiness({
    getExtension(id) {
      if (id !== "simple-local.simple-sftp-mac") return undefined;
      return {
        packageJSON: {
          version: "0.1.2",
          contributes: { commands: [
            { command: "simpleSftpMac.uploadWorkspace" },
            { command: "simpleSftpMac.uploadFiles" },
            { command: "simpleSftpMac.configureDownloadScope" },
          ] },
        },
      };
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.version, "0.1.2");
  assert.deepEqual(Array.from(ready.missingCommands), []);

  const outdated = readiness({
    getExtension(id) {
      if (id !== "simple-local.simple-sftp-mac") return undefined;
      return { packageJSON: { version: "0.1.0", contributes: { commands: [{ command: "simpleSftpMac.uploadWorkspace" }] } } };
    },
  });
  assert.equal(outdated.ready, false);
  assert.deepEqual(Array.from(outdated.missingCommands), ["simpleSftpMac.uploadFiles", "simpleSftpMac.configureDownloadScope"]);
  assert.match(outdated.message, /检查 preview 配套更新/);
});

test("SimpleSFTP integration readiness reuses ABI derivation and invalidates on extension replacement", () => {
  const readiness = loadReadiness();
  let packageReads = 0;
  const packageJSON = {
    version: "0.1.3",
    contributes: { commands: [
      { command: "simpleSftpMac.uploadWorkspace" },
      { command: "simpleSftpMac.uploadFiles" },
      { command: "simpleSftpMac.configureDownloadScope" },
    ] },
  };
  const extension = {};
  Object.defineProperty(extension, "packageJSON", {
    get() { packageReads += 1; return packageJSON; },
  });
  let legacyExtension;
  const registry = {
    getExtension(id) {
      if (id === "simple-local.simple-sftp-mac") return extension;
      if (id === "simple-local.simple-sftp-mac-manager") return legacyExtension;
      return undefined;
    },
  };

  const first = readiness(registry);
  const firstReads = packageReads;
  assert.equal(first.ready, true);
  assert.equal(readiness(registry), first);
  assert.equal(packageReads, firstReads);

  legacyExtension = { packageJSON: { version: "0.1.1" } };
  const withLegacy = readiness(registry);
  assert.notEqual(withLegacy, first);
  assert.equal(withLegacy.legacyInstalled, true);
  assert.equal(withLegacy.legacyVersion, "0.1.1");

  const upgraded = { packageJSON: { ...packageJSON, version: "0.1.4" } };
  const upgradedRegistry = {
    getExtension(id) {
      if (id === "simple-local.simple-sftp-mac") return upgraded;
      if (id === "simple-local.simple-sftp-mac-manager") return legacyExtension;
      return undefined;
    },
  };
  const upgradedResult = readiness(upgradedRegistry);
  assert.equal(upgradedResult.version, "0.1.4");
  assert.notEqual(upgradedResult, withLegacy);
});

test("new-project readiness and UI expose SimpleSFTP before remote submission", () => {
  assert.match(source, /const integrations = \{ simpleSftp: simpleSftpIntegrationReadiness\(\) \}/);
  assert.match(source, /simpleSftpReady: simpleSftp\.ready/);
  assert.match(source, /simpleSftp\?\.ready === false/);
  assert.match(source, /state: "simple_sftp_required"/);
  assert.match(source, /action: "打开配置说明"/);
  assert.match(source, /next === "打开配置说明"[\s\S]{0,100}this\.openSetupGuide\(\)/);
  assert.match(source, /const integration = simpleSftpIntegrationReadiness\(\)[\s\S]{0,120}if \(!integration\.ready\)/);
  assert.match(panel, /function simpleSftpCommandDisableReason\(state, command\)/);
  assert.match(panel, /simpleSftpCommandDisableReason\(state, command\)/);
  assert.match(panel, /state\.integrations/);
  assert.match(source, /SimpleSFTP 已安装但当前窗口尚未注册编排命令/);
  assert.match(source, /SIMPLE_SFTP_REQUIRED_COMMANDS\.filter\(\(command\) => !registered\.has\(command\)\)/);
});
