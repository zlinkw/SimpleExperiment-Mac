const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

test('portable formal PLAN + tmp/result isolates concurrent jobs and rejects inconsistent command targets', () => {
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', path.join(__dirname, 'planResultPathContract.fixture.py'), '--generic'], {
    cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.equal(JSON.parse(proc.stdout.trim()).ok, true);
});

test('actual MultiModal path guard, config snapshot and result collector agree; no training or writes', t => {
  const project = process.env.MULTIMODAL_PATH_CONTRACT_ROOT || 'D:/GitRepo/MultiModal';
  if (!fs.existsSync(path.join(project, 'experiments/quality_composition.py'))) { t.skip('set MULTIMODAL_PATH_CONTRACT_ROOT to the actual research checkout'); return; }
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', path.join(__dirname, 'planResultPathContract.fixture.py'), project], {
    cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const result = JSON.parse(proc.stdout.trim());
  assert.equal(result.path_error, '', JSON.stringify(result));
  for (const key of ['command_result', 'test_config', 'runtime_config', 'paper_config']) assert.equal(result[key], result.execution, key);
  assert.equal(result.contract.declared_result_csv, result.declared);
  assert.equal(result.contract.execution_result_csv, result.execution);
  assert.equal(result.contract.collection_result_csv, result.execution);
  assert.match(result.contract.plan_revision, /^[a-f0-9]{64}$/);
  assert.equal(result.preflight.ok, true, JSON.stringify(result.preflight));
  assert.ok(Object.keys(result.quality_plan_preflights).length >= 7);
  for (const [file, report] of Object.entries(result.quality_plan_preflights)) assert.equal(report.ok, true, file + JSON.stringify(report.missing));
  assert.equal(new Set(result.isolated_csvs).size, result.isolated_csvs.length);
  assert.equal(result.contract.policy, 'declared');
  assert.equal(result.contract.declared_output_dir, result.contract.execution_output_dir);
  assert.equal(result.declared, result.execution);
  assert.equal(Object.hasOwn(result.contract, 'attempt'), false);
  assert.match(result.attempt_rejection, /RESULT_PATH_DECLARATION_CHANGED/);
  assert.deepEqual(result.collection_csvs, result.isolated_csvs);
  assert.equal(result.shared_preflight.ok, false);
  assert.match(result.shared_preflight.missing.join(';'), /multiple jobs share one execution CSV/);
  assert.equal(result.literal_preflight.ok, false);
  assert.match(result.literal_preflight.missing.join(';'), /runner.test_command.*use \{result_csv\}/);
  assert.ok(path.isAbsolute(result.cwd_csv));
  assert.equal(result.cwd_config_csv, result.cwd_csv);
  assert.equal(result.unbound_preflight.ok, false);
  assert.equal(result.blocked_before_dispatch.length, 2);
  for (const message of result.blocked_before_dispatch) assert.match(message, /RESULT_PATH_INCOMPATIBLE.*experiments\/quality_paths\.py/);
  assert.match(result.stale_revision, /PLAN_REVISION_CHANGED/);
  assert.equal(result.fresh_revision_csv, result.execution);
  for (const section of ['runtime', 'paper']) assert.equal(result.snapshot_config[section].result_csv, result.execution);
  assert.equal(result.snapshot_config.test.results_csv, result.execution);
  assert.equal(result.wrapper_context.result_csv, result.execution);
  assert.deepEqual(result.guard_rejections, ['shared', 'escape', 'pressure', 'config_mismatch']);
  assert.deepEqual(result.preflight_writes, []);
  assert.equal(result.execution_plan, 'experiments/plans/quality_composition/late_fusion.yaml');
  const collector = require('../../dist/results/WrapperResultBundle');
  const files = collector.declaredWrapperResults(JSON.stringify(result.manifest), result.contract.execution_output_dir, result.execution);
  assert.ok(files.includes(result.execution), 'actual manifest collector must include the execution CSV');
  assert.equal(collector.jobResultPath(result.manifest.result_csv, result.contract.execution_output_dir, result.execution), result.execution);
});

test('structural cache keys reject old PLAN revision, code or project hook contents', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/extension/legacy.ts'), 'utf8');
  const start = source.indexOf('    planValidationCacheKey(body, workerId) {');
  const end = source.indexOf('    cachedPlanValidation(key)', start);
  assert.ok(start > 0 && end > start);
  const owner = Function('workspaceRoot', 'normalizePlanSelectionKey', 'pluginProjectAdapterRules', 'crypto',
    'return {' + source.slice(start, end) + '}')(() => '/project', x => x, () => ({ resultPathValidator: 'experiments/quality_paths.py' }), crypto);
  Object.assign(owner, {lastWorkerProbes: {worker: {agentVersion: 'fixture'}}, projectTopologyAssessment: () => ({mode: 'worker_pool'}),
    enabledWorkerConfigs: () => [{id: 'worker'}], lastCodeSyncState: {fingerprint: 'current-code'}});
  const request = {planFile: 'experiments/plans/quality_composition/late_fusion.yaml', planRevision: 'current'};
  const current = owner.planValidationCacheKey(request, 'worker');
  assert.ok(current);
  assert.notEqual(owner.planValidationCacheKey({...request, planRevision: 'stale'}, 'worker'), current);
  owner.lastCodeSyncState.fingerprint = 'changed-hook';
  assert.notEqual(owner.planValidationCacheKey(request, 'worker'), current);
  assert.equal(owner.planValidationCacheKey({...request, planRevision: ''}, 'worker'), '');
});
