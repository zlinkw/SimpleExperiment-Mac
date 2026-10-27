const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');
require('../_helpers/registerTsRequire');
const html = require('../../src/ui/PanelHtml.legacy.ts').renderPanelHtml();
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
const parsed = ts.createSourceFile('panel.js', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const functions = new Map();
let sections, click;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(parsed));
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'COMMAND_INSPECTOR_SECTIONS') sections = node.getText(parsed);
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'document.addEventListener'
    && node.arguments[0]?.text === 'click' && node.arguments[1]?.getText(parsed).includes('data-distributed-retry')) click = node.arguments[1].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
function fixture() {
  const outlets = Object.fromEntries(['commandPhaseLine', 'planCommandPhaseLine', 'resultCommandPhaseLine'].map(id => [id,
    { textContent: '', title: '', classList: { toggle(name, on) { this[name] = on; } } }]));
  const sandbox = { el: id => outlets[id], pendingActions: {}, pendingActionsById: {}, pendingButtonKeys: new Set(), pendingActionTimeouts: {},
    TERMINAL_UI_STATUSES: new Set(['completed', 'failed', 'cancelled']),
    clearConfigDraftsForCommand() {}, clearButtonsForPending() {}, clearPendingActionTimeout() {}, applyPendingButtonStates() {},
    COMMANDS_WITHOUT_LOADING: new Set(), RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS: new Set(), ARTIFACT_SCOPE_COMMANDS: new Set(),
    retryableTransferCommand: () => false, hidePinContextMenu() {}, setButtonLoading() {}, setTimeout: () => 1,
    vscode: { postMessage() {} }, render() {}, currentState: {}, lastState: null,
  };
  vm.createContext(sandbox);
  vm.runInContext('const ' + sections + ';\n' + ['planPhaseCommand', 'artifactSyncNoticeCommand', 'commandInspectorSection', 'commandPhaseSection',
    'renderCommandPhaseLine', 'isTerminalUiStatus', 'handleUiCommandStatus', 'payloadFromButton', 'commandNeedsLoading',
    'createClientActionId', 'pendingKeyForButton', 'pendingKeyForAction', 'pendingKeyFromButtonDataset']
    .filter(name => functions.has(name)).map(name => functions.get(name)).join('\n') + '\nthis.click = ' + click, sandbox);
  for (const name of ['planPhaseCommand', 'artifactSyncNoticeCommand']) assert.ok(functions.has(name), name + ' missing from the panel script');
  function add(command, id = command, section = '') {
    const row = { command, clientActionId: id, pendingKey: command, label: command, actionSection: section, message: '正在执行', status: 'running' };
    sandbox.pendingActionsById[id] = row; sandbox.pendingActions[command] = row; sandbox.pendingButtonKeys.add(command);
    return row;
  }
  return { sandbox, outlets, add };
}

// Requirement change (task ui-plan-gpu-progress-20261024 item 5): runPlan progress
// now lives only in its per-operation VS Code Notification, so it must be absent
// from every card grey line; results/execution routing coverage is unchanged.
test('result progress stays in the results section while Plan progress moves to its Notification', () => {
  for (const command of ['refreshLocalResults', 'rebuildProjectResultTables']) {
    const f = fixture(); f.add(command, command, 'sync'); f.add('runPlan'); f.add('stopAndClearPlan'); f.sandbox.renderCommandPhaseLine();
    assert.match(f.outlets.resultCommandPhaseLine.textContent, new RegExp(command));
    assert.equal(f.outlets.planCommandPhaseLine.textContent, '', 'runPlan stage must not repeat as card grey text');
    assert.match(f.outlets.commandPhaseLine.textContent, /stopAndClearPlan/);
    assert.doesNotMatch(f.outlets.commandPhaseLine.textContent, new RegExp(command + '|runPlan'));
  }
  // r4 migration (task ui-plan-gpu-progress-20261024 返修): the four artifact-sync commands
  // report through their per-operation Notification + full log now, so their grey phase
  // text moved out of the cards. The pending row itself stays registered, so button
  // loading/dedupe and terminal-state handling are unchanged; rebuildProjectResultTables
  // stays out of scope and keeps the grey line above.
  for (const command of ['syncPendingPlanArtifacts', 'syncAllResultArtifacts', 'refreshJobArtifacts', 'retryJobArtifactSync']) {
    const f = fixture(); f.add(command, command, 'results'); f.add('refreshLocalResults'); f.sandbox.renderCommandPhaseLine();
    assert.doesNotMatch(f.outlets.resultCommandPhaseLine.textContent, new RegExp(command), command + ': stage moved to its Notification');
    assert.match(f.outlets.resultCommandPhaseLine.textContent, /refreshLocalResults/, 'out-of-scope result routing keeps its grey line');
    assert.doesNotMatch(f.outlets.commandPhaseLine.textContent, new RegExp(command), command + ': must not leak into the execution line');
    assert.doesNotMatch(f.outlets.planCommandPhaseLine.textContent, new RegExp(command));
    assert.ok(f.sandbox.pendingActionsById[command], command + ': the pending row keeps button state and dedupe unchanged');
  }
});

test('explicit result actions route correctly and correlated terminal replies clear only their own progress', () => {
  const f = fixture(); f.add('customResultAction', 'old', 'results'); f.add('refreshLocalResults');
  f.sandbox.renderCommandPhaseLine(); assert.match(f.outlets.resultCommandPhaseLine.textContent, /customResultAction/);
  f.sandbox.handleUiCommandStatus({ command: 'customResultAction', clientActionId: 'old', status: 'failed', message: '失败' });
  assert.match(f.outlets.resultCommandPhaseLine.textContent, /refreshLocalResults/);
  f.sandbox.handleUiCommandStatus({ command: 'refreshLocalResults', clientActionId: 'refreshLocalResults', status: 'cancelled' });
  assert.equal(f.outlets.resultCommandPhaseLine.textContent, ''); assert.equal(f.outlets.resultCommandPhaseLine.classList.busy, false);
  f.add('refreshLocalResults', 'new'); f.sandbox.renderCommandPhaseLine();
  f.sandbox.handleUiCommandStatus({ command: 'refreshLocalResults', clientActionId: 'refreshLocalResults', status: 'completed' });
  assert.equal(f.sandbox.pendingActionsById.new.status, 'running');
  assert.match(f.outlets.resultCommandPhaseLine.textContent, /refreshLocalResults/);
});

test('results have a stable live outlet outside the rerendered summary and actual button clicks retain their section', () => {
  const section = html.match(/<section[^>]*data-section="results"[^>]*>([\s\S]*?)<\/section>/)[1];
  assert.match(section, /id="resultCommandPhaseLine"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.equal((html.match(/id="resultCommandPhaseLine"/g) || []).length, 1);
  assert.ok(section.indexOf('id="resultCommandPhaseLine"') < section.indexOf('id="resultSummary"'));
  for (const command of ['refreshLocalResults', 'syncPendingPlanArtifacts'])
    assert.ok(script.includes('data-command="' + command + '" data-action-section="results"'), command + ' button missing result association');
  // The legacy rebuild alias remains routable; the toolbar uses the current refresh/sync actions.
  for (const command of ['refreshLocalResults', 'syncPendingPlanArtifacts', 'rebuildProjectResultTables']) {
    const f = fixture();
    assert.equal(f.sandbox.commandInspectorSection(command), 'results');
  }
  const f = fixture();
  const button = { dataset: { command: 'syncPendingPlanArtifacts', actionSection: 'results' }, textContent: '下载指标并重新汇总',
    disabled: false, closest: () => null, getAttribute: () => null };
  f.sandbox.click({ preventDefault() {}, stopPropagation() {}, target: { closest: selector => selector === 'button[data-command]' ? button : null } });
  const item = Object.values(f.sandbox.pendingActionsById)[0]; assert.equal(item.actionSection, 'results');
  f.sandbox.handleUiCommandStatus({ command: item.command, clientActionId: item.clientActionId, status: 'running', message: '下载指标' });
  // r4 migration: this command's live progress now goes to its per-operation Notification,
  // so the card lines stay empty while the pending row (button loading/dedupe) is kept.
  assert.equal(f.outlets.resultCommandPhaseLine.textContent, ''); assert.equal(f.outlets.commandPhaseLine.textContent, '');
  assert.equal(f.sandbox.pendingActionsById[item.clientActionId].status, 'running', 'the button still tracks the in-flight sync');
});
