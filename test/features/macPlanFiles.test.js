const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const workspace = '/Users/科研/项目 A ';
const planDir = 'experiments/plans';
const names = ['A.yaml', 'a.yaml', ' 计划 中文.yaml ', 'A%20.yaml', 'é.yaml', 'e\u0301.yaml'];
function loadCompiled(relative, overrides = {}) {
  const file = path.join(root, relative), module = { exports: {} }, requireFile = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer,
    process: { platform: 'darwin' }, require: id => id in overrides ? overrides[id] : requireFile(id) }, { filename: file });
  return module.exports;
}
function filesystem() {
  const nodes = new Map(); let serial = 0, opened = 0, closed = 0, mutate;
  function add(file, type, text = '') {
    nodes.set(file, { type, text, ino: ++serial, mtimeMs: 1, ctimeMs: 1 });
  }
  function mkdir(file) {
    if (!nodes.has(file)) { if (file !== '/') mkdir(path.posix.dirname(file)); add(file, 'directory'); }
  }
  function write(relative, text) { const file = workspace + '/' + relative; mkdir(path.posix.dirname(file)); add(file, 'file', text); }
  mkdir(workspace);
  names.forEach((name, index) => write(planDir + '/' + name, `suite: suite-${index}\nbase_config: configs/train.yaml\nseeds: [42]\ncases:\n  - case: demo\n`));
  function lookup(file) {
    const exact = nodes.get(file);
    if (exact) return exact;
    // Simulate aliases on a case-insensitive disk; exact directory spelling must still win.
    const alias = [...nodes].find(([name]) => name.toLowerCase() === file.toLowerCase());
    if (alias) return alias[1];
    throw Object.assign(Error('missing ' + file), { code: 'ENOENT' });
  }
  function statOf(node) {
    return { dev: 1, ino: node.ino, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
      size: Buffer.byteLength(node.text), mtime: new Date(node.mtimeMs),
      isDirectory: () => node.type === 'directory', isFile: () => node.type === 'file', isSymbolicLink: () => node.type === 'link' };
  }
  function children(file) {
    assert.equal(lookup(file).type, 'directory');
    return [...nodes.keys()].filter(name => name !== file && path.posix.dirname(name) === file).map(name => path.posix.basename(name));
  }
  const api = { constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
    realpathSync: file => { lookup(file); return file; },
    statSync: file => statOf(lookup(file)), lstatSync: file => statOf(lookup(file)), readdirSync: children,
    promises: {
      readFile: async file => lookup(file).text,
      readdir: async (file, options) => children(file).map(name => options?.withFileTypes
        ? { name, ...statOf(lookup(file + '/' + name)) } : name),
      open: async (file, flags) => {
        assert.equal(flags, 3, 'actual reader must use NOFOLLOW and NONBLOCK'); opened++;
        const node = lookup(file);
        return { stat: async () => statOf(node),
          readFile: async () => { const bytes = Buffer.from(node.text); if (mutate) mutate(file, node); return bytes; },
          read: async buffer => { const bytes = Buffer.from(node.text); bytes.copy(buffer); if (mutate) mutate(file, node); return { bytesRead: Math.min(bytes.length, buffer.length) }; },
          close: async () => { closed++; } };
      },
    } };
  return { api, nodes, write, add, get opened() { return opened; }, get closed() { return closed; }, set mutate(fn) { mutate = fn; } };
}
function fixture() {
  const disk = filesystem();
  const files = loadCompiled('dist/mac/PlanFiles.js', { 'node:fs': disk.api, 'node:path': path.posix });
  const contract = loadCompiled('dist/features/DistributedProjectContract.js');
  const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true), functions = new Map(), methods = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const sandbox = vm.createContext({ process: { platform: 'darwin' }, path: path.posix, fs: disk.api.promises, crypto, Buffer,
    MacPlanFiles_1: files, normalizePosixRelativePath: require('../../dist/mac/PosixPath').normalizePosixRelativePath,
    localPlanSummaryReadBudgetBytes: 512 * 1024, localPlanSummaryConcurrency: 8,
    defaultYamlScanBudget: { maxFiles: 500, maxDirs: 800, maxDepth: 8 }, isHeavyProjectDir: () => false,
    PlanBuilder_1: require('../../dist/features/PlanBuilder'),
    normalizePlanArchiveEvidencePath: value => value || '',
    normalizeDistributedProjectContract: contract.normalizeDistributedProjectContract,
    workspaceRoot: () => workspace, makeOpId: () => 'distributed-mock',
    planValidationFromResult: value => value,
    PlanExecutionMode: require('../../dist/features/PlanExecutionMode'),
    DistributedSchedulingPolicy: require('../../dist/features/DistributedSchedulingPolicy'),
    DistributedPlanQueue: loadCompiled('dist/features/DistributedPlanQueue.js'),
    WorkflowBinding_1: { assertWorkflowWorkspace() {}, bindWorkflowWorkspace: () => ({}) },
    vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => sandbox.planDirConfig ?? fallback }) },
      window: { showInformationMessage: () => { throw Error('unexpected UI'); } } } });
  const functionNames = ['readLocalPlans', 'readLocalPlanSummary', 'readArchivedLocalPlans', 'readPlanArchiveBundle', 'archiveManifestFileList', 'walkYaml', 'isArchivedPlanFile', 'mapLimited', 'parseLocalPlanText',
    'sha256Text', 'safeWorkspacePlanPath', 'projectBootstrapPlanSelection', 'operationResultPlanFile', 'planDirSafe', 'normalizePlanSelectionKey', 'stringField'];
  const methodNames = ['distributedPlanEligible', 'distributedProjectContract', 'enqueueDistributedPlan', 'assertPlanLocalConfigFiles'];
  vm.runInContext(ts.transpileModule(functionNames.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n') +
    '\nclass Subject { ' + methodNames.map(name => methods.get(name)).join('\n') + '\n}\nthis.Subject = Subject;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return { disk, files, contract, sandbox };
}

test('compiled Mac relative and distributed contract paths retain spelling and reject implicit aliases', () => {
  const { contract } = fixture(), relative = require('../../dist/mac/PosixPath').normalizePosixRelativePath;
  for (const name of names) assert.equal(relative(planDir + '/' + name), planDir + '/' + name);
  const valid = contract.normalizeDistributedProjectContract({ planPrefixes: ['experiments/plans/ 组 /'], configPath: ' 配置 A.yaml ',
    checkpointPath: '模型/A%20.pth', requiredPaths: ['é.csv', 'e\u0301.csv'] });
  assert.equal(valid.planPrefixes[0], 'experiments/plans/ 组 /');
  assert.equal(valid.configPath, ' 配置 A.yaml ');
  assert.equal(valid.requiredPaths.includes('é.csv'), true); assert.equal(valid.requiredPaths.includes('e\u0301.csv'), true);
  for (const value of ['', '../a.yaml', './a.yaml', '/a.yaml', 'plans//a.yaml', 'plans\\a.yaml', 'C:/a.yaml', 'a\0.yaml', 'a\x7f.yaml', 12])
    assert.throws(() => relative(value));
  for (const value of ['../a', 'a\\b', 12, { path: 'a' }]) assert.throws(() => contract.normalizeDistributedProjectContract({ configPath: value }));
  assert.throws(() => contract.normalizeDistributedProjectContract({ requiredPaths: [12] }));
});

test('compiled Mac file guard confines exact directory entries and preserves absolute API paths', () => {
  const { files, disk } = fixture();
  const file = planDir + '/' + names[2];
  assert.equal(files.macPlanFile(workspace, file, planDir, true), workspace + '/' + file);
  assert.equal(files.macPlanFile(workspace, workspace + '/' + file, planDir, true), workspace + '/' + file);
  assert.equal(files.macPlanFile(workspace, planDir + '/新目录/ 新建.yaml ', planDir), workspace + '/' + planDir + '/新目录/ 新建.yaml ');
  for (const value of ['experiments/PLANS/A.yaml', planDir + '/A.YAML', planDir + '/../other.yaml', 'other.yaml', planDir + '//A.yaml', planDir + '/A.yaml\n'])
    assert.throws(() => files.macPlanFile(workspace, value, planDir, true));
  disk.add(workspace + '/' + planDir + '/link', 'link');
  assert.throws(() => files.macPlanFile(workspace, planDir + '/link/a.yaml', planDir), /符号链接/);
  disk.add(workspace + '/' + planDir + '/pipe.yaml', 'pipe');
  assert.throws(() => files.macPlanFile(workspace, planDir + '/pipe.yaml', planDir), /类型不符/);
  assert.equal(disk.opened, 0);
});

test('actual Mac scanner and summary reader select case, Unicode, percent and trailing-space files separately', async () => {
  const { sandbox, disk } = fixture();
  const plans = await sandbox.readLocalPlans(workspace, planDir);
  assert.equal(plans.length, names.length);
  for (let index = 0; index < names.length; index++) {
    const file = planDir + '/' + names[index], row = plans.find(plan => plan.planFile === file);
    assert.ok(row, file); assert.equal(row.suite, 'suite-' + index); assert.equal(row.name, names[index]);
    const selected = await sandbox.readLocalPlanSummary(workspace, planDir, file);
    assert.equal(selected.planFile, file); assert.equal(selected.revision, row.revision);
  }
  assert.equal(disk.opened, disk.closed);
  assert.throws(() => sandbox.safeWorkspacePlanPath(workspace, 'experiments/PLANS/A.yaml', planDir), /实验计划目录/);
});

test('actual bootstrap selection rejects a wrong explicit path and never defaults to another sole Plan', () => {
  const { sandbox } = fixture();
  const plans = names.map(name => ({ planFile: planDir + '/' + name }));
  const selected = sandbox.projectBootstrapPlanSelection(plans, plans[2].planFile, plans[0].planFile);
  assert.equal(selected.plan, plans[2]);
  const missing = sandbox.projectBootstrapPlanSelection([plans[0]], planDir + '/Missing.yaml', plans[0].planFile);
  assert.equal(missing.plan, undefined); assert.equal(missing.needsChoice, true);
  assert.equal(sandbox.projectBootstrapPlanSelection([plans[0]], '', '').plan, plans[0]);
});

test('actual Mac archived Plan metadata retains spelling without leaking into formal discovery', async () => {
  const { sandbox, disk } = fixture();
  const file = planDir + '/_archived/ 计划 A.yaml ';
  disk.write(file, 'suite: archived\n');
  const archived = await sandbox.readArchivedLocalPlans(workspace, planDir);
  assert.equal(archived.length, 1); assert.equal(archived[0].planFile, file);
  assert.equal(archived[0].archivedFile, file); assert.equal(archived[0].status, 'archived');
  assert.equal((await sandbox.readLocalPlans(workspace, planDir)).length, names.length);
});

test('actual Mac Plan directory configuration preserves real spaces and never rewrites bad settings', async () => {
  const { sandbox, disk } = fixture();
  sandbox.planDirConfig = 'experiments/ 计划 ';
  assert.equal(sandbox.planDirSafe(), sandbox.planDirConfig);
  disk.write(sandbox.planDirConfig + '/a.yaml ', 'suite: alternate\n');
  assert.equal((await sandbox.readLocalPlans(workspace, sandbox.planDirSafe()))[0].planFile, 'experiments/ 计划 /a.yaml ');
  for (const bad of ['experiments\\plans', '../plans', '/plans', 'plans//', 'plans/./', 12]) {
    sandbox.planDirConfig = bad; assert.throws(() => sandbox.planDirSafe());
  }
  sandbox.planDirConfig = planDir;
  disk.api.promises.readdir = async () => { throw Object.assign(Error('permission denied'), { code: 'EACCES' }); };
  await assert.rejects(sandbox.readLocalPlans(workspace, planDir), /permission denied/);
});

test('actual Mac local-config precheck reads the complete Plan beyond the preview budget', async () => {
  const { sandbox, disk } = fixture(), subject = new sandbox.Subject();
  const file = planDir + '/large.yaml';
  const text = '#'.repeat(1024 * 1024 + 1) + '\nbase_config: configs/last.yaml\n';
  disk.write(file, text);
  subject.isMacVariant = () => true; subject.localPlanForActionBody = () => ({ planFile: file });
  sandbox.planRuntimeConfigReferences = actual => { assert.equal(actual, text); throw Error('complete reference scan observed'); };
  await assert.rejects(subject.assertPlanLocalConfigFiles({ planFile: file }), /complete reference scan observed/);
  assert.equal((await sandbox.readLocalPlanSummary(workspace, planDir, file)).metadataTruncated, true);
  assert.equal(disk.opened, disk.closed);
});

test('compiled reader rejects file replacement, content changes and workspace replacement and always closes', async () => {
  for (const kind of ['file', 'content', 'workspace', 'none']) {
    const { files, disk } = fixture();
    disk.mutate = (file, node) => {
      if (kind === 'file') disk.add(file, 'file', 'other');
      if (kind === 'content') { node.text = 'changed'; node.mtimeMs++; }
      if (kind === 'workspace') disk.nodes.get(workspace).ino++;
    };
    const reading = files.readMacPlanPreview(workspace, planDir + '/A.yaml', planDir, 512 * 1024);
    if (kind === 'none') assert.match((await reading).text, /suite-0/);
    else await assert.rejects(reading, /已变化|期间变化/);
    assert.equal(disk.opened, 1); assert.equal(disk.closed, 1);
  }
});

test('actual distributed selection and enqueue preserve exact paths and reject bad outputs before writes', async () => {
  const { sandbox } = fixture(), subject = new sandbox.Subject();
  let queue = { schemaVersion: 1, plans: [] }, saves = 0;
  Object.assign(subject, { isMacVariant: () => true, projectTopologyAssessment: () => ({ mode: 'worker_pool' }),
    localPlanMetadata: { detectedProject: { adapterRules: { distributedResults: true } } },
    lastCodeSyncState: { fingerprint: 'fp' }, schedulerSettings: () => ({}), distributedQueueGeneration: 1,
    loadDistributedQueue: async () => queue, saveDistributedQueue: async (_root, next) => { saves++; queue = next; }, postState() {} });
  const file = planDir + '/' + names[2];
  assert.equal(subject.distributedPlanEligible(file), true);
  assert.equal(subject.distributedPlanEligible('experiments\\plans\\A.yaml'), false);
  for (const bad of ['../output', 'work_dirs//bad', 'work_dirs\\bad', '/output', 'work_dirs/./bad', 'a\x7f']) {
    await assert.rejects(subject.enqueueDistributedPlan({ planFile: file, planRevision: 'r' },
      { execution_mode: 'train', jobs: [{ index: 0, case: 'c', seed: 42, output_dir: bad }] }, true), /相对路径/);
    assert.equal(saves, 0);
  }
  await subject.enqueueDistributedPlan({ planFile: file, planRevision: 'r' },
    { execution_mode: 'train', jobs: [{ index: 0, case: 'c', seed: 42, output_dir: 'work_dirs/中文 A ' }] }, true);
  assert.equal(saves, 1); assert.equal(queue.plans[0].planFile, file);
  assert.equal(queue.plans[0].jobs[0].outputDir, 'work_dirs/中文 A /attempts/distributed-mock');
});
