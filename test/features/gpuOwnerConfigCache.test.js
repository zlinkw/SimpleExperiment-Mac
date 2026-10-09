const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractMethod(name) {
  const match = new RegExp(`^\\s*(?:private\\s+)?(?:async\\s+)?${name}\\(`, "m").exec(source);
  assert.ok(match, `missing method ${name}`);
  const body = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1).trim().replace(/^private\s+/, "");
  }
  throw new Error(`unterminated method ${name}`);
}

function loadSubject() {
  const values = {
    "gpu.currentUser": "alice",
    "gpu.currentUserAliases": ["researcher"],
    "gpu.myCommandKeywords": ["train.py"],
    "gpu.myProcessMatchMode": "both",
  };
  const sandbox = {
    process: { env: { USERNAME: "local-alice" } },
    configReads: 0,
    values,
    stringArrayConfig(value) {
      return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
    },
    vscode: {
      workspace: {
        getConfiguration() {
          sandbox.configReads += 1;
          return { get(key, fallback) { return Object.hasOwn(values, key) ? values[key] : fallback; } };
        },
      },
      window: { showInformationMessage: async () => undefined },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    class Subject {
      gpuOwnerConfigCache;
      tunnelConfig = { connectionMode: "xshell_tunnel_realtime" };
      setupConfig = {};
      postCount = 0;
      effectiveConnectionMode() { return this.tunnelConfig.connectionMode; }
      postState() { this.postCount += 1; }
      ${extractMethod("gpuOwnerConfig")}
      ${extractMethod("handleConfigurationChanged")}
    }
    this.Subject = Subject;
  `, sandbox);
  return sandbox;
}

test("GPU owner configuration reuses one Webview object until invalidated", () => {
  const sandbox = loadSubject();
  const subject = new sandbox.Subject();
  const first = subject.gpuOwnerConfig();

  assert.strictEqual(subject.gpuOwnerConfig(), first);
  assert.equal(sandbox.configReads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    currentUser: "alice",
    currentUserAliases: ["researcher"],
    myCommandKeywords: ["train.py"],
    myProcessMatchMode: "both",
    localUserHint: "local-alice",
  });

  sandbox.values["gpu.myProcessMatchMode"] = "invalid";
  subject.gpuOwnerConfigCache = undefined;
  const refreshed = subject.gpuOwnerConfig();
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.myProcessMatchMode, "both");
  assert.equal(sandbox.configReads, 2);
});

test("only GPU configuration changes invalidate the cached owner config", async () => {
  const sandbox = loadSubject();
  const subject = new sandbox.Subject();
  const first = subject.gpuOwnerConfig();
  const event = (gpuChanged) => ({
    affectsConfiguration(key) {
      if (key === "simpleExperiment") return true;
      if (key === "simpleExperiment.gpu") return gpuChanged;
      return false;
    },
  });

  await subject.handleConfigurationChanged(event(false));
  assert.strictEqual(subject.gpuOwnerConfig(), first);
  assert.equal(sandbox.configReads, 1);

  sandbox.values["gpu.currentUser"] = "bob";
  await subject.handleConfigurationChanged(event(true));
  const refreshed = subject.gpuOwnerConfig();
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.currentUser, "bob");
  assert.equal(sandbox.configReads, 2);
  assert.equal(subject.postCount, 2);
});

test("buildState publishes the cached GPU owner configuration", () => {
  assert.match(source, /gpuOwnerConfig: this\.gpuOwnerConfig\(\)/);
  assert.match(extractMethod("handleConfigurationChanged"), /affectsConfiguration\("simpleExperiment\.gpu"\)[\s\S]{0,100}gpuOwnerConfigCache = undefined/);
});
