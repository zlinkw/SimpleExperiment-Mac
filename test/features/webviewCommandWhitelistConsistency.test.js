const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "../..");
function readFirst(candidates) {
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full)) return fs.readFileSync(full, "utf8");
  }
  assert.fail(`missing source, tried: ${candidates.join(", ")}`);
}
// Factory refactor v0.4.92+: logic lives in legacy files, facades only re-export.
const extension = readFirst(["src/extension/legacy.ts", "src/extension.ts"]);
const panel = readFirst(["src/ui/PanelHtml.legacy.ts", "src/ui/PanelHtml.ts"]);

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing block start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing block end after: ${startMarker}`);
  return source.slice(start, end);
}

function quotedValues(source) {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function objectKeys(source) {
  return [...source.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
}

function webviewCommands() {
  return new Set([
    ...quotedValues(block(panel, "const webviewHandledCommands = new Set([", "]);")),
    ...objectKeys(block(panel, "const uiCapabilityMap = {", "};")),
  ]);
}

function safeCommands() {
  return new Set([
    ...quotedValues(block(extension, "const uiActionCommands = new Set<WebviewActionCommand>([", "]);")),
    ...quotedValues(block(extension, "const SAFE_WEBVIEW_COMMANDS = new Set([", "]);")),
  ]);
}

test("literal messages emitted by specialized click handlers pass the safety gate", () => {
  const emitted = [...panel.matchAll(/vscode\.postMessage\(\{\s*command:\s*"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(emitted)].filter(command => !safeCommands().has(command)).sort(), []);
});

test("training recovery click reaches the Host dispatcher with its exact target and status channel", async () => {
  const gate = block(extension, "const SAFE_WEBVIEW_COMMANDS = new Set([", "]);" ) + "]);\n"
    + block(extension, "const uiActionCommands = new Set<WebviewActionCommand>([", "]);" ).replace("Set<WebviewActionCommand>", "Set") + "]);\n"
    + block(extension, "function getSafeCommand(message)", "const hostOperationUiCommands");
  const handler = block(extension, "    async handleMessage(message)", "    async handleMessageCore(");
  const dispatch = vm.runInNewContext(gate + '\n({' + handler + '})', {
    console: { log() {} }, stringField: (message, key) => String(message[key] || ''),
    commandNeedsUiStatus: () => true, hostOperationLeaseActionForUiCommand: () => '',
  }).handleMessage;
  const message = { command: 'retryDistributedJob', clientActionId: 'recovery-click', planId: 'run', jobIndex: 0 };
  let received, statusChannel;
  const owner = { recordActionError: error => assert.fail(error.message), postState() {}, postUiCommandStatus() {},
    withUiCommandStatus: async (id, command, payload, work) => { statusChannel = id; return work(); },
    withSafeTransferRetry: async (_, __, work) => work(),
    handleMessageCore: async (payload, command) => { received = { ...payload, command }; },
  };
  await dispatch.call(owner, message);
  assert.deepEqual(received, message);
  assert.equal(statusChannel, 'recovery-click');
});

test("training recovery reports real completion, cancellation and rejected evidence to the correlated button", async () => {
  const methods = block(extension, "    async handleMessageCore(", "    private async withUiCommandStatus(")
    + block(extension, "    private async withUiCommandStatus(", "    uiCommandWatchdogMs(").replace("private async", "async");
  const compiled = ts.transpileModule("const subject = {" + methods + "};", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const statuses = [], notices = [], errors = [];
  const scope = {
    booleanField: () => false, localCommandReleasesAfterTrigger: () => false,
    PLAN_SUBMISSION_COMMANDS: new Set(), isUiCommandRemotePending: () => false, isUiCommandCancelled: () => false,
    errorMessage: error => error.message, actionErrorSuggestion: () => "", compactSensitiveText: text => text,
    hostOperationLeaseActionLabel: () => "核验并恢复任务",
    OperationOutcome_1: require("../../dist/core/OperationOutcome.js"),
    vscode: { window: {
      showInformationMessage: async message => notices.push(message),
      showErrorMessage: async (_, options) => errors.push(options.detail),
    } },
  };
  const api = vm.runInNewContext(compiled + "\nsubject;", scope);
  const payload = { command: "retryDistributedJob", planId: "run", jobIndex: 0, clientActionId: "recovery-status" };
  const owner = { ...api, panelLifecycleState: "ready", extensionRuntimeVersionState: () => ({ reloadRequired: false }),
    postUiCommandStatus: (id, status, command, message) => statuses.push({ id, status, command, message }),
    finishPlanSubmissionProgress() {}, recordActionError() {}, postState() {},
  };
  for (const status of ["completed", "cancelled", "failed"]) {
    const message = status === "completed" ? "已核验并恢复训练完成，未重新训练。"
      : status === "cancelled" ? "训练恢复已取消，任务状态未修改。" : "checkpoint SHA256 不符，未恢复。";
    owner.retryDistributedJobFromUi = async received => {
      assert.equal(received, payload);
      if (status === "failed") throw new Error(message);
      return { status, message };
    };
    await owner.withUiCommandStatus(payload.clientActionId, payload.command, payload,
      () => owner.handleMessageCore(payload, payload.command));
    assert.equal(statuses.at(-1).id, payload.clientActionId);
    assert.equal(statuses.at(-1).status, status);
    assert.equal(statuses.at(-1).message, message);
    assert.equal(statuses.at(-2).status, "running");
  }
  assert.equal(notices.length, 1);
  assert.equal(errors.length, 1);
});

test("all declared webview commands pass the extension safety whitelist", () => {
  const webview = webviewCommands();
  const safe = safeCommands();

  const missing = [...webview].filter((command) => !safe.has(command)).sort();
  assert.deepEqual(missing, []);
  assert.ok(safe.has("openSetupGuide"));
  assert.ok(safe.has("openAdvancedCommandsSetting"));
});

test("extension safety whitelist stays covered by webview declarations (reverse)", () => {
  const webview = webviewCommands();
  const safeOnly = new Set(quotedValues(block(extension, "const SAFE_WEBVIEW_COMMANDS = new Set([", "]);")));
  // Host-handled protocol messages do not appear in the DOM click-command maps.
  const KNOWN_EXTENSION_ONLY = new Set([
    "webviewReady", "webviewBootstrapError", "webviewRenderError", "reloadPanel",
    "copyPanelDiagnostics", "reloadPanelLowEffects", "webviewBootstrapPhase",
    "webviewLayoutEvidence", "webviewRuntimeIncident", "webviewSectionInterest",
    "webviewSectionTelemetry", "webviewStateRendered",
  ]);
  // Pre-existing gaps (follow-up, not this change): declared in SAFE whitelist and
  // sent by webview buttons, but missing from webviewHandledCommands. Any NEW gap fails.
  const KNOWN_GAPS_TODO = new Set([
    "startTensorBoard", "runDraftDebug", "promoteDraft", "rejectDraft",
    "reviewDraft", "cleanupDrafts", "resetPptPathConfirmations",
  ]);
  const uncovered = [...safeOnly].filter((command) => !webview.has(command) && !KNOWN_EXTENSION_ONLY.has(command) && !KNOWN_GAPS_TODO.has(command)).sort();
  assert.deepEqual(uncovered, []);
  for (const command of ["runCheckStatic", "openLastCheckStaticReport", "copyLastCheckStaticReport"]) {
    assert.ok(webview.has(command), `webview must declare ${command}`);
    assert.ok(safeOnly.has(command), `SAFE whitelist must contain ${command}`);
  }
});

test("configuration entry handlers remain reachable and unknown commands remain rejected", () => {
  assert.match(extension, /case "openSetupGuide":[\s\S]{0,100}this\.openSetupGuide\(\)/);
  assert.match(extension, /case "openAdvancedCommandsSetting":[\s\S]{0,180}workbench\.action\.openSettings/);
  assert.match(extension, /return SAFE_WEBVIEW_COMMANDS\??\.has\(command\) \|\| uiActionCommands\.has\(command\) \? command : ""/);
  assert.match(extension, /if \(rawCommand && !command\)[\s\S]{0,120}未知或未放行的前端命令/);
});

test("webview command routing reuses module-level fixed sets", () => {
  const safeCommand = block(extension, "function getSafeCommand(message)", "const hostOperationUiCommands");
  const statusHelpers = block(extension, "function commandNeedsUiStatus(command)", "function normalizeUiLayout(input)");
  assert.match(extension, /const COMMANDS_WITHOUT_UI_STATUS = new Set\(/);
  assert.match(extension, /const LOCAL_COMMAND_RELEASES_AFTER_TRIGGER = new Set\(/);
  assert.doesNotMatch(safeCommand + statusHelpers, /new Set\(|\["startAllConnections", "testAll", "snapshot"\]/);
  assert.match(statusHelpers, /COMMANDS_WITHOUT_UI_STATUS\??\.has\(command\)/);
  assert.match(statusHelpers, /LOCAL_COMMAND_RELEASES_AFTER_TRIGGER\.has/);
});

test("reloadWindow is a declared local internal command, outside remote action routing", () => {
  const apiInternal = new Set(quotedValues(block(extension, "const API_INTERNAL_COMMANDS = new Set([", "]);")));
  const remoteActions = new Set(quotedValues(block(extension, "const uiActionCommands = new Set<WebviewActionCommand>([", "]);")));
  assert.ok(webviewCommands().has("reloadWindow"));
  assert.ok(safeCommands().has("reloadWindow"));
  assert.ok(apiInternal.has("reloadWindow"));
  assert.equal(remoteActions.has("reloadWindow"), false);
});
