const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/legacy.ts'), 'utf8');
const ast = ts.createSourceFile('legacy.ts', source, ts.ScriptTarget.Latest, true);
const providerClass = ast.statements.find((node) => ts.isClassDeclaration(node)
  && node.name?.text === 'RealtimeTunnelPanelProvider');

function loadSnapshotBatchReader() {
  const method = providerClass.members.find((node) => node.name?.getText(ast) === 'readWorkerTaskSnapshotBatch');
  assert.ok(method, 'the host provider must expose a bounded worker snapshot batch reader');
  const code = `class Provider { ${method.getText(ast)} }; Provider;`;
  return vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { Promise, Map, Set, Number, String, ReturnType: undefined, setTimeout, clearTimeout });
}

test('a batch reads each configured worker once and returns healthy results without waiting for an offline worker', async () => {
  const Provider = loadSnapshotBatchReader();
  const provider = new Provider();
  const calls = [];
  provider.readWorkerTaskSnapshot = async (workerId) => {
    calls.push(workerId);
    if (workerId === 'worker-offline') return new Promise(() => undefined);
    return { workerId, generatedAt: 'fresh', capabilities: { queuedJobRecall: true }, tasks: [{ commandId: 'job-1' }] };
  };

  const snapshots = await provider.readWorkerTaskSnapshotBatch([
    'worker-a', 'worker-a', 'worker-a', 'worker-b', 'worker-offline', 'worker-b',
  ], { graceMs: 25 });

  assert.deepEqual(calls.sort(), ['worker-a', 'worker-b', 'worker-offline']);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(Array.from(snapshots.slice(0, 2), (snapshot) => snapshot.workerId), ['worker-a', 'worker-b']);
  assert.equal(snapshots[2].workerId, 'worker-offline');
  assert.equal(snapshots[2].pending, true);
  assert.match(snapshots[2].error, /still pending/);
  assert.deepEqual(Array.from(snapshots[2].tasks), []);
});

test('a late snapshot cannot replace the unknown result returned for its timed-out worker', async () => {
  const Provider = loadSnapshotBatchReader();
  const provider = new Provider();
  let resolveSlow;
  provider.readWorkerTaskSnapshot = async (workerId) => workerId === 'worker-slow'
    ? new Promise((resolve) => { resolveSlow = resolve; })
    : { workerId, tasks: [{ commandId: 'healthy' }] };

  const snapshots = await provider.readWorkerTaskSnapshotBatch(['worker-fast', 'worker-slow'], { graceMs: 10 });
  const slowSnapshot = snapshots.find((snapshot) => snapshot.workerId === 'worker-slow');
  resolveSlow({ workerId: 'worker-slow', tasks: [{ commandId: 'late-proof' }] });
  await Promise.resolve();

  assert.match(slowSnapshot.error, /still pending/);
  assert.deepEqual(Array.from(slowSnapshot.tasks), []);
});

test('boot reconciliation shares one worker snapshot across recalled jobs and isolates pending workers', () => {
  const tickStart = source.indexOf('async tickDistributedQueueCore(');
  const tickEnd = source.indexOf('async syncDistributedJobArtifacts(', tickStart);
  const tick = source.slice(tickStart, tickEnd);
  assert.match(tick, /this\.readWorkerTaskSnapshotBatch\(snapshotWorkerIds, \{ signal \}\)/);
  assert.match(tick, /new Map\(taskSnapshots\.map\(\(snapshot, index\) => \[snapshot\.workerId \|\| snapshotWorkerIds\[index\], snapshot\]\)\)/);
  assert.match(tick, /processDistributedRecall\(root, recall\.planId, recall\.jobIndex, generation,\s*snapshotsByWorker\.get\(recall\.workerId\)\)/);
  assert.doesNotMatch(tick, /mapLimited\(snapshotWorkerIds/);
  assert.match(tick, /if \(snapshot\.pending\) continue;[\s\S]*?if \(snapshot\.error\)/);
  assert.match(tick, /if \(snapshot\.error\)[\s\S]*?setJobState\(queue, plan\.id, job\.index, "unknown", job\.commandId\)/);
  const recallStart = source.indexOf('async recallPlanToLocalQueueFromUi(');
  const recallEnd = source.indexOf('async processDistributedRecall(', recallStart);
  const recall = source.slice(recallStart, recallEnd);
  assert.match(recall, /if \(singleJob\) \{[\s\S]*?processDistributedRecall\(root, planId, job\.index, generation\)/);
  assert.doesNotMatch(recall, /for \(const job of nextPlan\.jobs[\s\S]*?processDistributedRecall/);
});
