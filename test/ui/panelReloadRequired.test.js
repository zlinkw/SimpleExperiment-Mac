const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const identitySource = fs.readFileSync(path.join(__dirname, "../../src/features/PanelBuildIdentity.ts"), "utf8");
const identityModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(identitySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: identityModule.exports, module: identityModule, require });
const lifecycleSource = fs.readFileSync(path.join(__dirname, "../../src/features/PanelLifecycle.ts"), "utf8");
const lifecycleModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(lifecycleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: lifecycleModule.exports, module: lifecycleModule });
const extensionSource = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const recoverySource = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelRecoveryHtml.ts"), "utf8");
const recoveryModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(recoverySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recoveryModule.exports, module: recoveryModule });
const { renderPanelReloadRequiredHtml } = recoveryModule.exports;

function createProvider(registryVersion, identities = {}) {
  const ast = ts.createSourceFile("legacy.ts", extensionSource, ts.ScriptTarget.Latest, true);
  const providerNode = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "RealtimeTunnelPanelProvider");
  const methodNames = new Set(["extensionRuntimeVersionState", "handleExtensionRegistryChange", "showPanelReloadRequired", "loadPanelHtml", "stampPanelDocument", "clearPanelHeartbeat", "clearPanelReadyWatchdog", "transitionPanelLifecycle"]);
  const methods = providerNode.members.filter((node) => node.name && methodNames.has(node.name.getText(ast)));
  const code = ts.transpileModule(`class Subject {\n${methods.map((node) => node.getText(ast)).join("\n")}\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let installed = registryVersion;
  const rendered = { main: 0 };
  const sandbox = {
    vscode: { extensions: { getExtension: () => ({ packageJSON: { version: installed } }) } },
    renderPanelReloadRequiredHtml,
    renderPanelHtml: () => { rendered.main++; return "NORMAL PANEL"; },
    renderPanelRecoveryHtml: () => "RECOVERY PANEL",
    renderPanelBootstrapDocument: (render) => ({ html: render(), recovered: false }),
    PanelBuildIdentity_1: identityModule.exports,
    PanelLifecycle_1: lifecycleModule.exports,
    crypto: require("node:crypto"),
    clearTimeout,
  };
  vm.runInNewContext(`${code}\nthis.Subject = Subject;`, sandbox);
  const provider = new sandbox.Subject();
  provider.context = { extension: { packageJSON: { version: "0.5.194" } } };
  provider.runningBuildIdentity = identities.running || { version: "0.5.194", buildId: "a".repeat(64), manifestHash: "AAA", fingerprint: "AAA", exists: true };
  provider.diskBuildIdentity = identities.disk || provider.runningBuildIdentity;
  provider.readInstalledBuildIdentity = () => provider.diskBuildIdentity;
  provider.forceReloadRequired = false;
  provider.reloadRequiredReason = null;
  provider.panelLifecycleState = "ready";
  provider.panelLifecycleGeneration = 0;
  provider.webviewReady = true;
  provider.viewGeneration = 9;
  provider.panelDocumentGeneration = 0;
  provider.panelSectionRevisionTracker = { reset() {} };
  provider.markCurrentSessionPanelFailure = () => {};
  provider.resetPanelStateProgress = () => {};
  provider.syncPanelStateFlowVisibility = () => {};
  provider.statePostPending = true;
  provider.view = { visible: true, webview: { html: "", postMessage: () => Promise.resolve(true) } };
  provider.lastPanelLifecycleDiagnosticKey = "";
  provider.recordPanelLifecycleDiagnostic = () => {};
  provider.startPanelReadyWatchdog = () => {};
  return { provider, rendered, setInstalledVersion: (version) => { installed = version; } };
}

test("reload-required renderer is standalone, versioned, and sends reloadWindow", () => {
  const html = renderPanelReloadRequiredHtml({ runningVersion: "0.5.193", installedVersion: "0.5.194" });
  assert.match(html, /0\.5\.193/);
  assert.match(html, /0\.5\.194/);
  assert.match(html, /重载窗口/);
  assert.match(html, /command:"reloadWindow"/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /PanelHtml|simpleSftp|catalog|gpu/i);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
});

test("provider selects reload-required UI only for mixed extension versions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const loadPanel = source.slice(source.indexOf("private loadPanelHtml()"), source.indexOf("private reloadPanelHtml()"));
  const versionState = source.slice(source.indexOf("private extensionRuntimeVersionState()"), source.indexOf("private handleExtensionRegistryChange()"));
  assert.match(versionState, /PanelBuildIdentity_1\.classifyPanelBuildIdentity/);
  assert.match(versionState, /vscode\.extensions\.getExtension\("simple-local\.simple-experiment"\)/);
  assert.match(versionState, /content_mismatch/);
  assert.match(loadPanel, /if \(this\.extensionRuntimeVersionState\(\)\.reloadRequired\)\s*\{\s*this\.showPanelReloadRequired\(\);\s*return;/);
  assert.match(loadPanel, /renderPanelBootstrapDocument\(renderPanelHtml, renderPanelRecoveryHtml\)/);
  assert.match(source, /case "reloadWindow"[\s\S]{0,140}workbench\.action\.reloadWindow/);
});

test("extension registry change switches the active provider to reload-required page", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  assert.match(source, /vscode\.extensions\.onDidChange\(\(\) => this\.handleExtensionRegistryChange\(\)\)/);
  assert.match(source, /this\.context\.subscriptions\.push\(vscode\.extensions\.onDidChange/);
  const handler = source.slice(source.indexOf("private handleExtensionRegistryChange()"), source.indexOf("private recordPanelLifecycleDiagnostic()"));
  assert.match(handler, /if \(!versions\.reloadRequired\) return/);
  assert.match(handler, /this\.showPanelReloadRequired\(\)/);
  assert.match(source, /this\.context\.subscriptions\.push\(vscode\.extensions\.onDidChange/);
  assert.match(source, /if \(this\.extensionRuntimeVersionState\(\)\.reloadRequired\)[\s\S]{0,120}this\.showPanelReloadRequired\(\)/);
});

test("registry version change replaces the document and blocks main panel rendering", () => {
  const subject = createProvider("0.5.194");
  assert.equal(subject.provider.extensionRuntimeVersionState().reloadRequired, false);
  subject.setInstalledVersion("0.5.195");
  subject.provider.handleExtensionRegistryChange();
  assert.match(subject.provider.view.webview.html, /0\.5\.194/);
  assert.match(subject.provider.view.webview.html, /0\.5\.195/);
  assert.equal(subject.provider.webviewReady, false);
  assert.equal(subject.provider.statePostPending, false);
  subject.provider.loadPanelHtml();
  assert.equal(subject.rendered.main, 0);
  assert.match(subject.provider.view.webview.html, /重载窗口/);
});

test("matching versions still render the regular panel", () => {
  const subject = createProvider("0.5.194");
  subject.provider.loadPanelHtml();
  assert.equal(subject.rendered.main, 1);
  assert.equal(subject.provider.view.webview.html.includes("NORMAL PANEL"), true);
});

test("same-version content replacement is sticky and blocks the main panel", () => {
  const running = { version: "0.5.194", buildId: "a".repeat(64), manifestHash: "AAA", fingerprint: "AAA", files: {}, exists: true };
  const disk = { version: "0.5.194", buildId: "b".repeat(64), manifestHash: "BBB", fingerprint: "BBB", files: {}, exists: true };
  const subject = createProvider("0.5.194", { running, disk });
  const state = subject.provider.extensionRuntimeVersionState();
  assert.equal(state.registryState, "content_mismatch");
  assert.equal(state.reloadRequired, true);
  assert.equal(state.reason, "content_mismatch");
  subject.provider.loadPanelHtml();
  assert.equal(subject.rendered.main, 0);
  assert.match(subject.provider.view.webview.html, /版本号均为/);
  assert.match(subject.provider.view.webview.html, /AAA/);
  assert.match(subject.provider.view.webview.html, /BBB/);
});
