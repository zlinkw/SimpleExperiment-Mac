const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "vscode") return {
    commands: { executeCommand: async () => undefined },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {}, Uri: { file: (fsPath) => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
  };
  return originalLoad.call(this, request, ...args);
};
let RealtimeTunnelPanelProvider;
try { ({ RealtimeTunnelPanelProvider } = require("../../dist/extension/legacy.js")); }
finally { Module._load = originalLoad; }
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const PanelStateFlowControl = require("../../dist/features/PanelStateFlowControl.js");

// Reuse the browser harness without registering that file's independent tests.
const harnessSource = fs.readFileSync(path.join(__dirname, "panelRenderHealth.test.js"), "utf8");
const harnessAst = ts.createSourceFile("browser.js", harnessSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const browserFunction = harnessAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "fakeBrowser");
assert.ok(browserFunction, "rendered browser harness exists");
const fakeBrowser = vm.runInNewContext("(" + browserFunction.getText(harnessAst) + ")", { assert });
function scriptFrom(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.find((script) => script.includes("window.addEventListener(\"message\"") || script.includes("window.addEventListener('message'"));
  assert.ok(main, "main panel message handler script exists");
  return main;
}
function listener(browser) { return browser.windowListeners.get("message").values().next().value; }

test("a live unhealthy renderer replaces the actual stamped host document and restores its unfinished draft", () => {
  let html = "";
  let replacements = 0;
  const host = Object.assign(Object.create(RealtimeTunnelPanelProvider.prototype), {
    view: { visible: true, webview: {
      get html() { return html; }, set html(value) { html = value; replacements++; },
    } },
    panelDisposed: false, panelDocumentGeneration: 17, panelHeartbeatId: 41,
    panelSectionRevisionTracker: { reset() {} },
    webviewReady: true, webviewDocumentVisible: true, panelStateFlow: PanelStateFlowControl.createPanelStateFlowControlState(17, true),
    lastDeliveredStateSeq: 0, automaticRecoveryCount: 0, lastAutomaticRecoveryAt: null, recoveryLoopPreventedCount: 0,
    currentSessionRecoveryReason: "", currentSessionPanelLifecycleDiagnostics: [], panelLifecycleDiagnostics: [],
    panelHeartbeatIntervalMs: 30000, panelHeartbeatAckTimeoutMs: 12000,
    context: { extension: { packageJSON: { version: "0.5.181" } } },
    startPanelReadyWatchdog() {}, clearPanelReadyWatchdog() {},
    transitionPanelLifecycle(state) { this.panelLifecycleState = state; },
    extensionRuntimeVersionState() { return { reloadRequired: false, reason: "" }; },
    recordPanelLifecycleDiagnostic() {}, markCurrentSessionPanelFailure(reason) { this.currentSessionRecoveryReason = reason; },
    recordActionError(entry) { assert.fail("unexpected bootstrap failure: " + entry.message); },
  });
  const first = fakeBrowser({ documentGeneration: "17", missingRoots: new Set(["mainColumn"]) });
  vm.runInNewContext(scriptFrom(host.stampPanelDocument(renderPanelHtml(), 17)), first.context);
  const input = first.element("unfinished-host");
  input.dataset = { configInput: "hub", key: "host" };
  input.value = "unfinished.example";
  for (const onInput of first.documentListeners.get("input") || []) onInput({ target: input });
  listener(first)({ data: { type: "panelHeartbeat", heartbeatId: 41, documentGeneration: 17 } });
  const oldAck = first.sent.findLast((message) => message.command === "webviewHeartbeatAck");
  assert.equal(oldAck.documentGeneration, "17");
  assert.equal(oldAck.renderHealth.status, "unhealthy");
  host.handlePanelHeartbeatAck(oldAck);
  assert.equal(replacements, 1, "the production host replaces an alive but unusable document");
  assert.equal(host.panelDocumentGeneration, 18);
  assert.match(html, /<html data-panel-document-generation="18"/);

  const second = fakeBrowser({ initialState: first.webviewState, documentGeneration: "18", fastPath: true, selectConfigInputs: true });
  const restored = second.element("restored-host");
  restored.dataset = input.dataset;
  vm.runInNewContext(scriptFrom(html), second.context);
  listener(second)({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  [...second.frames.values()].at(-1)();
  assert.equal(restored.value, "unfinished.example", "document recovery preserves the unfinished configuration");
  const timeout = setTimeout(() => {}, 1000);
  timeout.unref();
  host.panelHeartbeatTimeout = timeout;
  try {
    host.handlePanelHeartbeatAck(oldAck);
    assert.equal(host.panelHeartbeatTimeout, timeout, "the old document cannot acknowledge the new document's request");
    assert.equal(replacements, 1);
    host.webviewReady = true;
    listener(second)({ data: { type: "panelHeartbeat", heartbeatId: 41, documentGeneration: 18 } });
    const newAck = second.sent.findLast((message) => message.command === "webviewHeartbeatAck");
    assert.equal(newAck.documentGeneration, "18");
  } finally { host.clearPanelHeartbeat(); }
});

test("all release version declarations and generated runtime components agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/runtime/RuntimeManifest.json"), "utf8"));
  const source = fs.readFileSync(path.join(root, "src/runtime/RuntimeManifest.ts"), "utf8");
  const declared = source.match(/CURRENT_RUNTIME_VERSION\s*=\s*"([^"]+)"/)[1];
  const versions = [lock.version, lock.packages[""].version, declared, manifest.pluginVersion,
    manifest.runtimeVersion, manifest.unifiedVersion, ...Object.values(manifest.components).map((component) => component.version)];
  assert.ok(versions.every((version) => version === pkg.version), "all release version declarations must agree");
});
