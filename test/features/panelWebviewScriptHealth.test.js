const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

function loadSourceRenderer() {
  const sourcePath = path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(code, sourcePath);
  return loaded.exports.renderPanelHtml;
}

const renderPanelHtml = loadSourceRenderer();

function extractScripts(html) {
  const scripts = [];
  const expression = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = expression.exec(html))) scripts.push(match[1]);
  assert.ok(scripts.length, "script tag missing");
  return scripts;
}

test("panel webview script parses and keeps config commands", () => {
  const html = renderPanelHtml();
  const scripts = extractScripts(html);
  for (let index = 0; index < scripts.length; index += 1) {
    assert.doesNotThrow(() => new vm.Script(scripts[index], { filename: `panel-webview-${index + 1}.js` }));
  }
  const script = scripts.join("\n");
  for (const command of [
    "configureSessions",
    "saveHubConfig",
    "saveWorkerConfig",
    "addWorkerConfig",
    "deleteWorkerConfig",
    "saveSchedulerConfig",
    "writeAgentCommands",
    "startAllConnections",
    "testAll",
  ]) {
    assert.match(html, new RegExp(command));
  }
  assert.match(script, /代码版本不匹配/);
  assert.match(script, /status-warning/);
  assert.equal((script.match(/const blockedOnly/g) || []).length, 1);
  assert.match(script, /isParseableResultCandidate/);
  assert.match(script, /jobs\.csv/);
  assert.match(script, /documentGeneration: panelDocumentGeneration/);
  assert.match(script, /renderHealth/);
  assert.match(script, /state-render-frame-stalled/);
  assert.match(script, /required-render-root-missing/);
});

test("training recovery clicks track each job and send a correlated status request", () => {
  const script = extractScripts(renderPanelHtml()).join("\n");
  const parsed = ts.createSourceFile("panel-click.js", script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const names = new Set(["payloadFromButton", "commandNeedsLoading", "createClientActionId",
    "pendingKeyForButton", "pendingKeyForAction", "pendingKeyFromButtonDataset"]);
  const helpers = [];
  let click;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) helpers.push(node.getText(parsed));
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "document.addEventListener"
      && node.arguments[0]?.text === "click" && node.arguments[1]?.getText(parsed).includes("data-distributed-retry"))
      click = node.arguments[1].getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(helpers.length, names.size);
  assert.ok(click, "actual recovery click handler missing");
  const sent = [], loading = [];
  const sandbox = {
    vscode: { postMessage: payload => sent.push(payload) },
    COMMANDS_WITHOUT_LOADING: new Set(), RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS: new Set(), ARTIFACT_SCOPE_COMMANDS: new Set(),
    pendingButtonKeys: new Set(), pendingActions: {}, pendingActionsById: {}, pendingActionTimeouts: {},
    retryableTransferCommand: () => false, planPhaseCommand: () => false, renderCommandPhaseLine() {}, hidePinContextMenu() {},
    setButtonLoading: (button, key) => loading.push({ button, key }), setTimeout: () => 1,
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers.join("\n") + "\nthis.click = " + click + ";", sandbox);
  const button = index => ({ dataset: { distributedRetry: "original-run", jobIndex: String(index), planFile: "plans/train.yaml" },
    textContent: "核验并恢复训练完成", disabled: false, closest: () => null, getAttribute: () => null });
  function press(target) {
    sandbox.click({ preventDefault() {}, stopPropagation() {}, target: { closest(selector) {
      if (selector === "button[data-distributed-retry]") return target;
      if (selector === "button[data-command]" && target.dataset.command) return target;
      return null;
    } } });
  }
  const first = button(0);
  press(first);
  press(first);
  press(button(1));
  assert.equal(sent.length, 2, "deduplicate the same job, retain independent job requests");
  assert.equal(loading.length, 2);
  for (let index = 0; index < sent.length; index++) {
    const payload = sent[index];
    assert.equal(payload.command, "retryDistributedJob");
    assert.equal(payload.planId, "original-run");
    assert.equal(payload.planFile, "plans/train.yaml");
    assert.equal(payload.jobIndex, index);
    assert.ok(payload.clientActionId);
    assert.equal(sandbox.pendingActionsById[payload.clientActionId].jobIndex, index);
    assert.equal(sandbox.pendingKeyFromButtonDataset(loading[index].button), loading[index].key);
  }
  assert.match(loading[0].key, /jobIndex=0/);
  assert.notEqual(loading[0].key, loading[1].key);
});
