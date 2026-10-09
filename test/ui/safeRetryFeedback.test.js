const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../src/ui/PanelHtml.legacy.ts'), 'utf8');
function extract(name) {
  const start = source.indexOf('    function ' + name + '(');
  const next = source.indexOf('\n    function ', start + 1);
  assert.ok(start >= 0 && next > start);
  return source.slice(start, next);
}
test('late old transfer status cannot clear or overwrite replacement progress', () => {
  const old = { clientActionId: 'old', pendingKey: 'k', command: 'syncPendingPlanArtifacts', status: 'running' };
  const fresh = { ...old, clientActionId: 'new' }; let clears = 0;
  const sandbox = { pendingActionsById: { old, new: fresh }, pendingActions: { k: fresh },
    isTerminalUiStatus: value => ['cancelled', 'failed', 'completed'].includes(value),
    clearPendingActionTimeout: () => clears++ };
  vm.createContext(sandbox); vm.runInContext(extract('handleUiCommandStatus') + '\nthis.handle = handleUiCommandStatus;', sandbox);
  sandbox.handle({ clientActionId: 'old', status: 'running', message: 'stale' });
  assert.equal(fresh.status, 'running'); assert.equal(fresh.message, undefined);
  sandbox.handle({ clientActionId: 'old', status: 'cancelled' });
  assert.equal(sandbox.pendingActions.k, fresh); assert.equal(sandbox.pendingActionsById.new, fresh);
  assert.equal(sandbox.pendingActionsById.old, undefined); assert.equal(clears, 1);
  sandbox.handle({ clientActionId: 'old', command: old.command, status: 'completed' });
  assert.equal(sandbox.pendingActions.k, fresh); assert.equal(clears, 1);
});
test('only supported explicit transfer actions remain clickable during loading', () => {
  const sandbox = { pendingActions: {}, loadingButtonCount: 0 };
  vm.createContext(sandbox);
  vm.runInContext(extract('retryableTransferCommand') + extract('setButtonLoading') + '\nthis.load = setButtonLoading;', sandbox);
  for (const command of ['syncAllResultArtifacts', 'syncPendingPlanArtifacts', 'rebuildProjectResultTables', 'runPlan', 'deleteArtifacts']) {
    sandbox.pendingActions.k = { command, clientActionId: 'new' };
    const button = { dataset: {}, disabled: false, classList: { contains: () => false, add() {} }, setAttribute() {}, querySelector: () => ({}) };
    sandbox.load(button, 'k');
    assert.equal(button.disabled, ['runPlan', 'deleteArtifacts'].includes(command));
    assert.equal(button.dataset.clientActionId, 'new');
  }
});
