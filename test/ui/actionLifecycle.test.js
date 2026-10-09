const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = source.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return source.slice(start, end + 1);
}

test("webview terminal uiCommandStatus clears button loading by client action", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/ui/PanelHtml.ts");
  const handler = source.match(/function handleUiCommandStatus[\s\S]*?function clearCompletedPendingButtons/)?.[0] || "";
  assert.match(handler, /clientActionId/);
  assert.match(handler, /isTerminalUiStatus\(data\.status\)/);
  assert.match(handler, /delete pendingActionsById\[clientActionId\]/);
  assert.match(handler, /clearPendingActionTimeout\(clientActionId\)/);
  assert.match(handler, /clearButtonsForPending\(clientActionId, pendingKey, data\.command\)/);
  assert.match(handler, /!item && !isTerminalUiStatus\(data\.status\)/);
});

test("webview command watchdog is scoped to client action id", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/ui/PanelHtml.ts");
  const clickHandler = source.match(/const pendingKey = pendingKeyForButton\(button, command, payload\);[\s\S]*?vscode\.postMessage\(Object\.assign\(\{ command \}, payload\)\)/)?.[0] || "";
  const clearBlock = source.match(/function clearPendingActionTimeout[\s\S]*?function clearButtonsForPending/)?.[0] || "";
  assert.match(source, /let pendingActionTimeouts = \{\}/);
  assert.match(clickHandler, /pendingActionTimeouts\[clientActionId\] = setTimeout/);
  assert.match(clickHandler, /const item = pendingActionsById\[clientActionId\]/);
  assert.doesNotMatch(clickHandler, /pendingActionsById\[clientActionId\] \|\| pendingActions\[pendingKey\]/);
  assert.match(clearBlock, /clearTimeout\(timer\)/);
  assert.match(clearBlock, /delete pendingActionTimeouts\[clientActionId\]/);
});

test("extension action operations use stable ids and watchdog terminal states", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/extension.ts");
  assert.match(source, /operationId\?: string/);
  assert.match(source, /request\.operationId = request\.opId/);
  assert.match(source, /scheduleOperationWatchdog\(request\.opId, action\)/);
  assert.match(source, /status: "stalled"/);
  assert.match(source, /operationTerminalStatus/);
  assert.match(source, /"stalled"/);
  assert.match(source, /"unsupported"/);
});

test("extension compacts operation payload without dropping active operations", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/extension.ts");
  const runtimeEvidence = source.match(/private buildPlanRuntimeEvidenceState\(\)[\s\S]*?return \{ connectionMode, realtimeState, snapshot, offlineSnapshot, schedulerStates, operations \};/)?.[0] || "";
  const compact = source.match(/function compactOperationRecords[\s\S]*?function operationTerminal/)?.[0] || "";

  assert.match(source, /const LOCAL_OPERATION_RECORD_LIMIT = 120/);
  assert.match(source, /const STATE_OPERATION_RECORD_LIMIT = 120/);
  assert.match(source, /const TERMINAL_OPERATION_RECORD_LIMIT = 80/);
  assert.doesNotMatch(runtimeEvidence, /queueProjectLocalOperationsStatePersistence\(|persistProjectLocalOperationsState\(/);
  assert.match(runtimeEvidence, /const operations = compactOperationRecords\(/);
  assert.match(compact, /entries\.length <= limit\)\s*return record && typeof record === "object" \? record : \{\}/);
  assert.match(compact, /if \(!operationTerminal\(entry\[1\]\)\)\s*active\.push\(entry\)/);
  assert.match(compact, /operationFailureTerminalStatus\(operationStatusOf\(entry\[1\]\)\)/);
  assert.match(compact, /const sortedEntries = sortOperationEntries\(entries\)/);
  assert.match(compact, /for \(const entry of sortedEntries\)/);
  assert.match(compact, /active\.forEach\(add\)/);
  assert.match(compact, /terminal\.slice\(0, terminalLimit\)\.forEach\(add\)/);
  assert.equal((compact.match(/sortOperationEntries\(/g) || []).length, 2);
});

test("local operation persistence is dirty-gated, single-flight, and project-scoped", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/extension.ts");
  const queue = source.match(/private queueProjectLocalOperationsStatePersistence\(\)[\s\S]*?async persistProjectLocalOperationsState/)?.[0] || "";

  assert.match(queue, /this\.localOperationsPersistPromise \|\| !this\.localOperationsDirty/);
  assert.match(queue, /const projectContext = this\.captureProjectContext\(\)/);
  assert.match(queue, /while \(this\.localOperationsDirty && this\.projectContextIsCurrent\(projectContext\)\)/);
  assert.match(queue, /this\.localOperationsDirty = false;[\s\S]*?await this\.withPluginStateFileLease\(projectContext\.root, file, "project-state-local-operations", "保存本地操作记录", \(\) => writeProjectLocalOperationsState\(projectContext\.root, operations\)\)/);
  assert.match(queue, /if \(this\.projectContextIsCurrent\(projectContext\)\)\s*this\.localOperationsDirty = true/);
  assert.match(queue, /this\.localOperationsPersistPromise === persistence/);
  assert.match(queue, /!failed \|\| !this\.projectContextIsCurrent\(projectContext\)/);
});

test("local toolbar commands wait for extension terminal status", async () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/extension.ts");
  assert.match(source, /function localCommandReleasesAfterTrigger/);
  assert.match(source, /const LOCAL_COMMAND_RELEASES_AFTER_TRIGGER = new Set\(\["startAllConnections", "testAll", "snapshot"\]\)/);
  assert.match(source, /return LOCAL_COMMAND_RELEASES_AFTER_TRIGGER\.has/);
  assert.match(source, /已触发本地 VS Code 操作/);
  const start = source.indexOf("    private async withUiCommandStatus(");
  const end = source.indexOf("    uiCommandWatchdogMs(", start);
  assert.ok(start >= 0 && end > start);
  const emitted = require("typescript").transpileModule(
    "(" + source.slice(start, end).replace("private async withUiCommandStatus", "async function") + ");",
    { compilerOptions: { target: require("typescript").ScriptTarget.ES2022 } },
  ).outputText;
  const context = vm.createContext({
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "runAllPlans", "reproducePlan"]),
    OperationOutcome_1: require("../../dist/core/OperationOutcome.js"),
  });
  vm.runInContext(extractConst(source, "LOCAL_COMMAND_RELEASES_AFTER_TRIGGER") + "\n" + extractFunction(source, "localCommandReleasesAfterTrigger"), context);
  const run = vm.runInContext(emitted, context);
  const statuses = [];
  const host = { postUiCommandStatus: (_id, status) => statuses.push(status) };
  let finish;
  const pending = run.call(host, "tmux-click", "fetchTmuxList", {}, () => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ["running"]);
  finish({});
  await pending;
  assert.deepEqual(statuses, ["running", "completed"]);
});

test("webview repeated render does not preserve disabled state for loading buttons", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/ui/PanelHtml.ts");
  assert.match(source, /const alreadyLoading = button\.classList\.contains\("is-loading"\)/);
  assert.match(source, /if \(!alreadyLoading\) button\.dataset\.wasDisabled/);
  assert.match(source, /delete button\.dataset\.clientActionId/);
});

test("webview command lifecycle reuses fixed status and command sets", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/ui/PanelHtml.ts");
  const sandbox = {
    COMMANDS_WITHOUT_LOADING: new Set(["selectPlan", "selectExperiment", "selectLogRunKey", "openPlan", "status"]),
    TERMINAL_UI_STATUSES: new Set(["completed", "submitted", "failed", "cancelled", "stalled"]),
    SUBMITTED_RUN_COMMANDS: new Set(["runPlan", "reproducePlan", "runAllPlans"]),
    CONFIG_SAVE_COMMANDS: new Set(["saveTopologyMode", "saveHubConfig", "saveWorkerConfig", "saveSchedulerConfig", "saveProjectAdapterRules"]),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(source, "commandNeedsLoading"),
    extractFunction(source, "isTerminalUiStatus"),
    extractFunction(source, "submittedCommandTarget"),
    extractFunction(source, "isConfigSaveCommand"),
    "this.api = { commandNeedsLoading, isTerminalUiStatus, submittedCommandTarget, isConfigSaveCommand };",
  ].join("\n"), sandbox);

  assert.equal(sandbox.api.commandNeedsLoading("status"), false);
  assert.equal(sandbox.api.commandNeedsLoading("runPlan"), true);
  assert.equal(sandbox.api.isTerminalUiStatus("STALLED"), true);
  assert.equal(sandbox.api.isTerminalUiStatus("running"), false);
  assert.equal(sandbox.api.submittedCommandTarget("runAllPlans", "submitted"), null);
  assert.equal(sandbox.api.submittedCommandTarget("restoreArchivedPlan", "completed"), null);
  assert.equal(sandbox.api.submittedCommandTarget("runPlan", "running"), null);
  assert.equal(sandbox.api.isConfigSaveCommand("saveSchedulerConfig"), true);
  assert.equal(sandbox.api.isConfigSaveCommand("runPlan"), false);

  assert.match(source, /const COMMANDS_WITHOUT_LOADING = new Set\(/);
  assert.match(source, /const TERMINAL_UI_STATUSES = new Set\(/);
  assert.match(source, /const SUBMITTED_RUN_COMMANDS = new Set\(/);
  assert.match(source, /const CONFIG_SAVE_COMMANDS = new Set\(/);
  assert.match(source, /COMMANDS_WITHOUT_LOADING\??\.has\(String\(command \|\| ""\)\)/);
  assert.match(source, /TERMINAL_UI_STATUSES\??\.has\(String\(status \|\| ""\)\.toLowerCase\(\)\)/);
  assert.doesNotMatch(source, /navigateToResourceTarget\(submittedTarget\./);
  assert.match(source, /CONFIG_SAVE_COMMANDS\??\.has\(String\(command \|\| ""\)\)/);
});

test("pending action scope selectors reuse fixed keys and data attributes", () => {
  const root = path.resolve(__dirname, "..", "..");
  const source = readSource("src/ui/PanelHtml.ts");
  const sandbox = { cssEscape: (value) => String(value) };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst(source, "PENDING_SCOPE_KEYS"),
    extractConst(source, "PENDING_SCOPE_DATA_ATTRIBUTES"),
    extractFunction(source, "pendingScopeKeys"),
    extractFunction(source, "pendingActionIsScoped"),
    extractFunction(source, "buttonHasPendingScope"),
    extractFunction(source, "pendingActionSelector"),
    extractFunction(source, "dataAttributeName"),
    "this.api = { pendingScopeKeys, pendingActionIsScoped, buttonHasPendingScope, pendingActionSelector, dataAttributeName };",
  ].join("\n"), sandbox);

  const keys = sandbox.api.pendingScopeKeys();
  assert.equal(sandbox.api.pendingScopeKeys(), keys);
  assert.equal(sandbox.api.pendingActionIsScoped({ planFile: "demo.yaml" }), true);
  assert.equal(sandbox.api.buttonHasPendingScope({ dataset: { configScope: "scheduler" } }), true);
  assert.equal(sandbox.api.pendingActionSelector({ command: "runPlan", runKey: "run-1", planFile: "demo.yaml" }), 'button[data-command="runPlan"][data-run-key="run-1"][data-plan-file="demo.yaml"]');
  assert.equal(sandbox.api.dataAttributeName("runKey"), "data-run-key");
  assert.equal(sandbox.api.dataAttributeName("clientActionId"), "data-client-action-id");
  assert.equal(sandbox.api.dataAttributeName("toString"), "data-to-string");
  assert.match(source, /const PENDING_SCOPE_KEYS = Object\.freeze\(\[/);
  assert.match(source, /const PENDING_SCOPE_DATA_ATTRIBUTES = Object\.freeze\(\{/);
  assert.doesNotMatch(extractFunction(source, "pendingScopeKeys"), /return \[/);
});
