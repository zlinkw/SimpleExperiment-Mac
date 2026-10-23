const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const ts = require('typescript');

test('foreground terminal polling does not add broad tmux reconciliation between status reads', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  function method(name) {
    const start = source.indexOf('\n    async ' + name + '(');
    assert.ok(start > 0, name);
    const tail = source.slice(start + 1);
    const next = tail.slice(12).search(/\n {4}(?:private |async )*[A-Za-z_][A-Za-z0-9_]*\([^;]*\) \{/);
    assert.ok(next > 0, name + ' end');
    return tail.slice(0, next + 12);
  }
  const code = ts.transpileModule(`class Host { ${method('waitForOperationTerminalResult')} ${method('refreshOperationStatus')} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const proto = new Function('ProgressInactivity', 'remoteActionPendingStatus', 'resultStatus', 'stringFromRecord',
    'sleep', 'operationLongRunningAction', 'operationSubmissionAccepted', 'operationTerminal',
    `${code}\nreturn Host.prototype;`)(
    require('../../dist/core/ProgressInactivity.js').ProgressInactivity,
    status => ['accepted', 'running'].includes(status), row => row?.status,
    (row, keys) => keys.map(key => row?.[key]).find(Boolean) || '', async () => {},
    () => false, () => false, row => row?.status === 'completed');
  let reads = 0, reconciles = 0;
  const client = { getWorkerOperation: async (_worker, id) => {
    assert.equal(id, 'original-operation');
    return ++reads === 1 ? { status: 'running', payload: { phase: 'assets', processedBytes: 64 } }
      : { status: 'completed' };
  }};
  const host = { ...proto, client, projectContextGeneration: 1, localOperations: {}, operationStatusProbeMaxAttempts: 4,
    assertActionAuthorityCurrent() {}, operationManualWaitDelayMs: () => 0, markLocalOperationsDirty() {},
    clearOperationStatusProbe() {}, clearOperationWatchdog() {}, postState() {}, throwIfTerminalActionFailure() {},
    shouldRetryOperationStatusProbe: () => true, scheduleOperationStatusProbe() {},
    reconcileSingleRunOperationEvidence: async () => { reconciles += 1; return { terminal: false }; },
  };
  // Class methods are non-enumerable.
  host.refreshOperationStatus = proto.refreshOperationStatus;
  const result = await proto.waitForOperationTerminalResult.call(host, 'validate-plan',
    { status: 'accepted', operationId: 'original-operation' }, 'validate', 90000, 'worker');
  assert.equal(result.status, 'completed');
  assert.equal(reads, 2);
  assert.equal(reconciles, 0);
});

test('real admission, busy queue, Worker and Scheduler retain structural gates without project science', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'formalJobPreflightProgress.fixture.py'), 'staged'], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || String(proc.error));
  const result = JSON.parse(proc.stdout.trim());
    assert.deepEqual(result.callbacks, []);
  assert.equal(result.receipt.admissionAssetChecks, 0);
  assert.equal(result.receipt.busyPollAssetChecks, 0);
  assert.equal(result.receipt.startupAssetChecks, 0);
  assert.equal(result.receipt.finalAssetChecks, 0);
  assert.equal(result.executionStarted, false);
});

test('original SHA diagnostic distinguishes metadata from content without renewing an execution proof', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8',
    path.join(__dirname, 'codeProofDiagnostic.fixture.py')], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || String(proc.error));
  assert.deepEqual(JSON.parse(proc.stdout.trim()), {
    readonly: true, metadataOnlyAcceptedByDiagnostic: true, executionStillRejects: true, contentChangedRejected: true,
  });
});
