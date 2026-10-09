const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

function methodAt(name, from = 0) {
  const matched = new RegExp(`\\n    (?:async |private async )?${name}\\(`).exec(extension.slice(from));
  return matched ? from + matched.index : -1;
}
function methodSource(name, nextName) {
  const start = methodAt(name);
  const end = methodAt(nextName, start + name.length);
  assert.ok(start > 0 && end > start, `${name} bounds`);
  return extension.slice(start, end)
    .replace(/body:\s*\{[^{}]*\}/g, "body")
    .replace(/([A-Za-z0-9_]+)\s*:\s*any\b/g, "$1")
    .replace(/([A-Za-z0-9_]+)\s*:\s*string\b/g, "$1")
    .replace(/([A-Za-z0-9_]+)\s*:\s*boolean\b/g, "$1")
    .replace(/<string,\s*true>/g, "")
    .replace(/\)\s*:\s*[^{;\n]+\{/g, ") {")
    .replace(/ as (?:const|any|typeof import\("[^"]+"\)|\{[^{}]*\})/g, "")
    .replace(/private async /g, "async ")
    .replace(/^\s*(async\s+)?([A-Za-z0-9_]+\()/, (_full, asyncKeyword, signature) => `${asyncKeyword || ""}function ${signature}`);
}

test("clearTmuxTaskTabs status keeps the real success and partial-failure text", async () => {
  const source = [
    "const errorMessage = (error) => String(error && error.message || error);",
    "const isUiCommandRemotePending = () => false;",
    "const isUiCommandCancelled = (error) => error && error.name === 'UiCommandCancelled';",
    "const localCommandReleasesAfterTrigger = () => false;",
    "const actionErrorSuggestion = () => '';",
    "const hostOperationLeaseActionLabel = () => '';",
    "const compactSensitiveText = (value) => String(value || '');",
    "const PLAN_SUBMISSION_COMMANDS = new Set();",
    "const booleanField = () => false;",
    "const debugModeBlockedUiCommand = () => false;",
    "class UiCommandCancelled extends Error { constructor(message) { super(message); this.name = 'UiCommandCancelled'; } }",
    methodSource("withUiCommandStatus", "uiCommandWatchdogMs"),
  ].join("\n");
  const statuses = [];
  const sandbox = {
    statuses,
    OperationOutcome_1: require("../../dist/core/OperationOutcome.js"),
    tmuxClearTaskTabsInFlight: false,
    clearOutcome: "已关闭 2/2 个任务标签。",
    async clearTmuxTaskTabsFromUi() { return this.clearOutcome; },
    postUiCommandStatus(clientActionId, status, command, message) {
      statuses.push({ clientActionId, status, command, message });
    },
    uiCommandWatchdogMs() { return 0; },
    finishPlanSubmissionProgress() {},
    recordActionError() {},
    postState() {},
    view: null,
    vscode: { window: {
      showInformationMessage: () => Promise.resolve(),
      showErrorMessage: () => Promise.resolve(),
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.report = withUiCommandStatus;`, sandbox);
  const report = vm.runInContext("report", sandbox);
  const okMessage = { command: "clearTmuxTaskTabs", clientActionId: "clear-ok", workerId: "NWPU3", session: "zlk-gpu-0", targets: ["zlk-gpu-0:2", "zlk-gpu-0:3"] };
  await report.call(sandbox, "clear-ok", "clearTmuxTaskTabs", okMessage, () => sandbox.clearTmuxTaskTabsFromUi(okMessage));
  assert.equal(statuses.at(-1).status, "completed", statuses.at(-1).message);
  assert.match(statuses.at(-1).message, /已关闭 2\/2/);

  sandbox.clearOutcome = null;
  sandbox.clearTmuxTaskTabsFromUi = async function clearFailed() {
    throw new Error("已关闭 1/2 个任务标签。失败 1 个：zlk-gpu-0:3（busy）");
  };
  const failMessage = { ...okMessage, clientActionId: "clear-fail" };
  await report.call(sandbox, "clear-fail", "clearTmuxTaskTabs", failMessage, () => sandbox.clearTmuxTaskTabsFromUi(failMessage));
  assert.equal(statuses.at(-1).status, "failed");
  assert.match(statuses.at(-1).message, /已关闭 1\/2/);
  assert.match(statuses.at(-1).message, /zlk-gpu-0:3/);
  assert.equal(statuses.filter((item) => item.status === "completed" && item.message === "completed").length, 0);
});
