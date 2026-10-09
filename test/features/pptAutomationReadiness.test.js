const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const {
  PptPlotBridge,
  defaultPptAutomationReadiness,
  pptAutomationReadinessFromError,
} = require("../../dist/PptPlotBridge.js");

function stateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-ppt-"));
}

function writeAutomation(root, options = {}) {
  const dir = path.join(root, "RoughPptAddin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "automation.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:51234",
    schemaVersion: options.schemaVersion ?? 1,
  }));
  if (options.token !== false) {
    fs.writeFileSync(path.join(dir, "automation.token"), options.token || "test-token");
  }
}

function response(status, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
    body: { getReader() {
      let used = false;
      return { async read() { if (used) return { done: true }; used = true; return { done: false, value: bytes }; }, async cancel() {} };
    } },
  };
}

test("PPT automation readiness distinguishes startup and contract failures", async () => {
  const initial = defaultPptAutomationReadiness();
  assert.equal(initial.state, "unknown");
  assert.equal(initial.actionCommand, "refreshPptAutomation");

  const missingRoot = stateRoot();
  const missing = await new PptPlotBridge({ localAppData: missingRoot }).inspectAutomation();
  assert.equal(missing.state, "not_running");
  assert.equal(missing.actionCommand, "startPptAutomation");

  const incompatibleRoot = stateRoot();
  writeAutomation(incompatibleRoot, { schemaVersion: 2 });
  const incompatible = await new PptPlotBridge({ localAppData: incompatibleRoot }).inspectAutomation();
  assert.equal(incompatible.state, "incompatible");
  assert.equal(incompatible.actionCommand, "openPptAutomationGuide");

  const malformedRoot = stateRoot();
  const malformedDir = path.join(malformedRoot, "RoughPptAddin");
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, "automation.json"), "{broken");
  const malformed = await new PptPlotBridge({ localAppData: malformedRoot }).inspectAutomation();
  assert.equal(malformed.state, "incompatible");

  const tokenRoot = stateRoot();
  writeAutomation(tokenRoot, { token: false });
  const tokenMissing = await new PptPlotBridge({ localAppData: tokenRoot }).inspectAutomation();
  assert.equal(tokenMissing.state, "token_missing");
});

test("PPT automation startup and health require schemaVersion 1", async () => {
  const root = stateRoot();
  let launches = 0;
  const bridge = new PptPlotBridge({
    localAppData: root,
    launchPowerPoint() {
      launches += 1;
      writeAutomation(root);
    },
    fetch: async () => response(200, { ok: true, schemaVersion: 1 }),
    sleep: async () => {},
    healthTimeoutMs: 100,
    healthPollMs: 1,
  });
  const ready = await bridge.prepareAutomation("");
  assert.equal(launches, 1);
  assert.equal(ready.ready, true);
  assert.equal(ready.schemaVersion, 1);

  const badHealth = await new PptPlotBridge({
    localAppData: root,
    fetch: async () => response(200, { ok: true, schemaVersion: 2 }),
  }).inspectAutomation();
  assert.equal(badHealth.state, "incompatible");
});

test("PPT automation HTTP failures map to actionable states", async () => {
  const bridge = new PptPlotBridge({
    fetch: async () => response(409, { ok: false, error: "已有 PPT 自动绘图请求正在执行" }),
  });
  await assert.rejects(
    () => bridge.postPlotRequest({ baseUrl: "http://127.0.0.1:51234", token: "test" }, {}),
    (error) => {
      const readiness = pptAutomationReadinessFromError(error);
      assert.equal(readiness.state, "busy");
      assert.equal(readiness.actionCommand, "refreshPptAutomation");
      return true;
    }
  );
});

test("result UI exposes PPT readiness without entering experiment gates", () => {
  const extension = readSource("src/extension.ts");
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.match(extension, /void this\.refreshPptAutomationReadiness\(false\)/);
  assert.match(extension, /pptAutomation: this\.pptAutomationReadiness/);
  const refresh = extension.match(/async refreshPptAutomationReadiness\(start\)[\s\S]*?async openPptAutomationGuide/)?.[0] || "";
  assert.match(refresh, /const projectContext = this\.captureProjectContext\(\);\s*const generation = projectContext\.generation/);
  assert.match(refresh, /const presentationPath = this\.pptPlotConfig\(\)\.presentationPath/);
  assert.match(refresh, /if \(generation !== this\.projectContextGeneration\)\s*return this\.pptAutomationReadiness/);
  assert.match(refresh, /bridge\.prepareAutomation\(presentationPath, signal\)/);
  assert.doesNotMatch(refresh, /bridge\.prepareAutomation\(this\.pptPlotConfig\(\)\.presentationPath\)/);
  assert.match(refresh, /if \(generation === this\.projectContextGeneration\)\s*this\.postState\(true\)/);
  assert.match(panel, /function pptAutomationReadinessForState\(state\)/);
  assert.match(panel, /PPT 版本不兼容/);
  assert.match(panel, /const plotDisabled = !statisticsSourcePath \|\| !automation\.ready/);
  assert.match(panel, /stage\.command === "plotResultsToPpt"/);
  assert.doesNotMatch(extension, /projectBootstrapCompletion[\s\S]{0,300}pptAutomation/);
});
