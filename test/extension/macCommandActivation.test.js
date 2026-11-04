const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const root = process.env.SIMPLE_STARTUP_PACKAGE_ROOT || path.resolve(__dirname, '../..');
const commands = new Map(), leases = [], errors = [], views = new Map();
let failCommand;
const vscode = {
  workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
  Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
  window: { showErrorMessage: async message => { errors.push(message); },
    registerWebviewViewProvider(id, provider) { views.set(id, provider); return { dispose() { views.delete(id); } }; } },
  commands: { registerCommand(id, handler) {
    if (id === failCommand) throw Error('fixture registration failure');
    if (commands.has(id)) throw Error('duplicate command: ' + id);
    commands.set(id, handler);
    return { dispose() { commands.delete(id); } };
  } },
};
const original = Module._load;
Module._load = function (name, parent, ...args) {
  if (name === 'vscode') return vscode;
  if (name === '../core/HostOperationLease' && parent?.filename.endsWith(path.join('factories', 'CommandFactory.js'))) {
    return { withHostOperationLease: async (label, work) => { leases.push(label); return work(); } };
  }
  return original.call(this, name, parent, ...args);
};
test.after(() => { Module._load = original; });
const { RealtimeTunnelPanelProvider: Provider } = require(path.join(root, 'dist/extension/legacy.js'));
const { DefaultCommandFactory, COMMAND_MANIFEST } = require(path.join(root, 'dist/factories/CommandFactory.js'));
const { registerProviderCommands, resolveCommandHandlerMap } = require(path.join(root, 'dist/extension/ProviderCommands.js'));
const pkg = require(path.join(root, 'package.json'));

function fixture(overrides = {}) {
  commands.clear(); leases.length = 0; errors.length = 0; views.clear(); failCommand = undefined;
  const provider = Object.assign(Object.create(Provider.prototype), overrides);
  const context = { subscriptions: [] }, factory = new DefaultCommandFactory();
  const register = () => registerProviderCommands({ factoryContext: {}, commandFactory: factory, provider }, context);
  return { provider, context, register };
}

test('actual Mac Provider handlers register the whole factory batch including openPanel', async () => {
  let opened = false;
  const f = fixture({ openPanel() { opened = this === f.provider; } });
  // No Provider constructor, local API, SSH connection or business operation is started.
  assert.equal(typeof f.provider.stopMacSystemTunnels, 'function');
  assert.doesNotThrow(f.register);
  assert.deepEqual([...commands.keys()], COMMAND_MANIFEST.map(row => row.id));
  assert.ok(commands.has('simpleExperimentMac.openPanel'), "command 'simpleExperimentMac.openPanel' not found");
  await commands.get('simpleExperimentMac.openPanel')();
  assert.equal(opened, true);
  assert.deepEqual(leases, [], 'opening the panel stays a read-only navigation command');
});

test('all existing Mac platform commands are registered, routed and retain their lease boundary', async () => {
  const calls = [];
  const f = fixture({
    stopMacSystemTunnels(ids) { calls.push(['stop', ids, this === f.provider]); },
    configureManualEndpoints() { calls.push(['configure', this === f.provider]); },
    showManualAgentGuide() { calls.push(['guide', this === f.provider]); },
  });
  f.register();
  const ids = ['simpleExperimentMac.stopMacSystemTunnels', 'simpleExperimentMac.configureManualEndpoints', 'simpleExperimentMac.showManualAgentGuide'];
  for (const id of ids) {
    assert.ok(pkg.contributes.commands.some(row => row.command === id));
    assert.equal(typeof commands.get(id), 'function', id);
  }
  await commands.get(ids[0])(['configured-id']);
  await commands.get(ids[1])();
  await commands.get(ids[2])();
  assert.deepEqual(calls, [['stop', ['configured-id'], true], ['configure', true], ['guide', true]]);
  assert.deepEqual(leases, ids);
});

test('a missing actual Provider handler still rejects registration instead of silently omitting commands', () => {
  const f = fixture({ copyPanelDiagnosticsFromUi: undefined });
  assert.equal(resolveCommandHandlerMap(f.provider)['simpleExperimentMac.copyPanelDiagnostics'], undefined);
  assert.throws(f.register, /命令没有实际处理器.*simpleExperimentMac.copyPanelDiagnostics/);
  assert.equal(commands.size, 0);
});

test('registration API failure still rolls back the batch and surfaces its real error', () => {
  const f = fixture(); failCommand = 'simpleExperimentMac.quickSetup';
  assert.throws(f.register, /注册未完成.*fixture registration failure/);
  assert.equal(commands.size, 0);
  assert.equal(f.context.subscriptions.length, 0);
});

test('actual activation registers the Mac panel and open command before deferred background work', async () => {
  const { DefaultServiceFactory } = require(path.join(root, 'dist/factories/ServiceFactory.js'));
  const activation = require(path.join(root, 'dist/extension/Activation.js'));
  const f = fixture({ startLocalApiServer: async () => {}, reconcileStalePlanRunOperations: async () => {},
    runActivationOnboarding: async () => {}, dispose: async () => {} });
  const create = DefaultServiceFactory.prototype.createPanelProvider;
  DefaultServiceFactory.prototype.createPanelProvider = () => f.provider;
  const context = { subscriptions: [], globalState: { get: (_key, fallback) => fallback, update: async () => {} },
    workspaceState: { get: (_key, fallback) => fallback, update: async () => {} } };
  try {
    await activation.activate(context);
    assert.equal(activation.getProvider(), f.provider);
    assert.equal(views.get('simpleExperimentMac.panel'), f.provider);
    assert.equal(typeof commands.get('simpleExperimentMac.openPanel'), 'function');
    assert.deepEqual(errors, []);
  } finally {
    await activation.deactivate();
    for (const disposable of context.subscriptions) disposable.dispose?.();
    DefaultServiceFactory.prototype.createPanelProvider = create;
  }
});
