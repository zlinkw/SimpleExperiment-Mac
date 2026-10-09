const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const scope = require('../../dist/mac/ResultOperationScope');
const plan = 'Plans/ 中文 é A.yaml ', file = 'outputs/ 指标.csv ';
const plain = value => JSON.parse(JSON.stringify(value));
function backend(platform = 'darwin') {
  const source = fs.readFileSync(path.join(root, 'dist/extension/legacy.js'), 'utf8');
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true), funcs = new Map();
  (function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) funcs.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); })(ast);
  const names = ['remoteResultInspectionCandidates', 'remoteResultOperationPayloads', 'operationResultPlanFile',
    'normalizePlanSelectionKey', 'planFileEquivalenceKeys', 'samePlanSelection', 'uniqueStrings', 'stringFromRecord',
    'planVersionTimestamp', 'normalizeRemoteResultInspectionPath', 'usableSelectionKey'];
  const posix = require('../../dist/mac/PosixPath');
  const context = vm.createContext({ process: { platform }, Buffer, Date, Map, Set,
    MacResultOperationScope: scope, PosixPath_1: posix,
    FileTransferTypes_1: require('../../dist/tunnel/FileTransferTypes'),
    WrapperResultBundle: require('../../dist/results/WrapperResultBundle') });
  vm.runInContext(names.map(name => { assert.ok(funcs.has(name), name); return funcs.get(name); }).join('\n') +
    '\nthis.candidates=remoteResultInspectionCandidates;', context);
  return (rows, selected = plan, revision = 'r1', updatedAt = '') => plain(context.candidates([rows], selected, revision, updatedAt));
}
const receipt = extra => ({ type: 'check-output-contract', planFile: plan, planRevision: 'r1',
  updatedAt: '2026-10-10T00:00:00Z', contractReport: { unparseableFiles: [file] }, ...extra });

test('actual compiled Mac receipt preserves complete Plan and original result paths', () => {
  const candidates = backend();
  for (const selected of [plan, plan.toLowerCase(), plan.replace('é','e\u0301'), plan.replace(' A','%20A'), 'nested/'+plan]) {
    const row = receipt({ planFile: selected, selectedPlanId: selected, options: { plan_file: selected, plan_revision: 'r1' } });
    assert.deepEqual(candidates([row], selected), [file]);
    if (selected !== plan) assert.deepEqual(candidates([row]), []);
  }
  for (const selected of [null, [plan], {toString:()=>plan}, 123, '', '-', '../Plan.yaml', 'Plans\\A.yaml'])
    assert.deepEqual(candidates([receipt()], selected), []);
});

test('all supplied Plan aliases and typed wrappers must agree before candidates are authorized', () => {
  const candidates = backend();
  for (const key of ['planFile','plan_file','plan','selectedPlanId','selected_plan_id']) {
    for (const value of [null, [plan], 1, {}, plan.trim(), plan.toLowerCase(), 'A.yaml', 'Plans/../A.yaml'])
      assert.deepEqual(candidates([receipt({[key]:value})]), [], key);
  }
  for (const key of ['payload','latestEvent','contractReport','options'])
    for (const value of [[], 'invalid', 1]) assert.deepEqual(candidates([receipt({[key]:value})]), [], key);
  assert.deepEqual(candidates([receipt({options:{selectedPlanId:plan.trim()}})]), []);
  assert.deepEqual(candidates([receipt({latestEvent:{payload:{plan_file:plan.trim(),unparseableFiles:['outputs/foreign.csv']}}})]), []);
});

test('owned root and options authorize terminal event structural descendants in the compiled backend', () => {
  const candidates = backend();
  const terminal = { action:'check-output-contract', planFile:plan, selectedPlanId:plan, planRevision:'r1',
    status:'completed', contractReport:{planFile:plan, checkedAt:'2026-10-10T00:00:00Z', unparseable:[{path:file}]}};
  assert.deepEqual(candidates([{type:'operation_completed',payload:terminal}]), [file]);
  assert.deepEqual(candidates([{options:{plan:plan,planRevision:'r1'},action:'check-output-contract',payload:{unparseable_files:[file]}}]), [file]);
  assert.deepEqual(candidates([{planFile:plan,planRevision:'r1',latestEvent:{payload:terminal}}]), [file]);
});

test('child Plan never lends authorization to anonymous ancestor or sibling artifact data', () => {
  const candidates = backend();
  const child = {planFile:plan,planRevision:'r1',contractReport:{unparseableFiles:[file]}};
  const row = {type:'check-output-contract',unparseableFiles:['outputs/ancestor.csv'],payload:child,
    contractReport:{unparseableFiles:['outputs/sibling.csv']},latestEvent:{unparseableFiles:['outputs/event.csv']}};
  assert.deepEqual(candidates([row]), [file]);
  assert.deepEqual(candidates([{type:'check-output-contract',planRevision:'r1',updatedAt:'2026-10-10T00:00:00Z',
    unparseableFiles:[file],payload:{planFile:plan}}]), [], 'anonymous ancestor cannot lend revision or freshness');
  const scoped=scope.scopeMacResultOperation(row,plan);
  assert.equal(scoped.payloads.length,2);assert.ok(scoped.payloads.every(entry=>entry.planFile===plan));
  assert.ok(scoped.payloads.every(entry=>!entry.payload&&!entry.contractReport&&!entry.latestEvent));
  assert.equal(row.payload,child);assert.deepEqual(row.unparseableFiles,['outputs/ancestor.csv']);
});

test('receipt revision aliases and owners cannot borrow the first matching revision', () => {
  const candidates = backend();
  for (const bad of [null, {}, ['r1'], 1, ' r1', 'r1 ', 'r2'])
    assert.deepEqual(candidates([receipt({plan_revision:bad})]), []);
  assert.deepEqual(candidates([receipt({contractReport:{planRevision:'r2',unparseableFiles:[file]}})]), []);
  assert.deepEqual(candidates([receipt({options:{planRevision:'r2'}})]), []);
  assert.deepEqual(candidates([receipt({contractReport:{unparseable:[{path:file,planFile:plan.trim()}]}})]), []);
  assert.deepEqual(candidates([receipt({contractReport:{unparseable:[{path:file,plan_revision:'r2'}]}})]), []);
  assert.deepEqual(candidates([receipt({planRevision:'r2'})]), []);
});

test('freshness comes from owned receipt records and latest empty report suppresses older files', () => {
  const candidates = backend(), old=receipt({updatedAt:'2026-10-09T00:00:00Z'});
  const latest=receipt({updatedAt:'2026-10-10T00:00:00Z',contractReport:{unparseableFiles:[]}});
  assert.deepEqual(candidates([old,latest]), []);
  assert.deepEqual(candidates([old],plan,'', '2026-10-09T12:00:00Z'), []);
  const anonymous={updatedAt:'2026-10-10T00:00:00Z',type:'check-output-contract',
    payload:{planFile:plan,updatedAt:'2026-10-09T00:00:00Z',unparseableFiles:[file]}};
  assert.deepEqual(candidates([anonymous],plan,'','2026-10-09T12:00:00Z'), []);
  anonymous.payload.updatedAt='2026-10-10T00:00:00Z';
  assert.deepEqual(candidates([anonymous],plan,'','2026-10-09T12:00:00Z'), [file]);
});

test('Mac receipt scope bounds malformed trees and preserves read-only behavior', () => {
  const cycle=receipt();cycle.payload=cycle;
  assert.deepEqual(backend()([cycle]),[]);
  const deep=receipt();let child=deep;for(let i=0;i<10;i++){child.payload={};child=child.payload;}
  assert.deepEqual(backend()([deep]),[]);
  const bad=receipt({contractReport:{unparseableFiles:[null,{},[file],'/etc/passwd','../outside.csv','outputs/model.pt',file]}});
  assert.deepEqual(backend()([bad]),[file]);
  const row=receipt(), before=JSON.stringify(row);backend()([row]);assert.equal(JSON.stringify(row),before);
});

test('non-Mac compiled receipt candidates retain established compatibility behavior', () => {
  const row=receipt({planFile:'EXPERIMENTS/PLANS/DEMO.yaml',contractReport:{unparseableFiles:['outputs\\value.csv']}});
  assert.deepEqual(backend('win32')([row],'demo.yaml'),['outputs/value.csv']);
});
