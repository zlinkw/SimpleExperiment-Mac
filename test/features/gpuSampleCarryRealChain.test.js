// Item 85/167 real agent-chain evidence, extracted from the actual runtime
// sources: the fast execution inventory only CARRIES an already-collected GPU
// sample (cache read under the lock, never nvidia-smi), a missing sample stays
// missing without any synchronous sampling, and collected samples carry their
// own seq/epoch/generatedAt which inventory copies never re-stamp or corrupt.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

function extractTopLevel(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('def ' + name + '('));
  assert.ok(start >= 0, 'def ' + name + ' must exist in the real runtime source');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) if (/^(def |class )/.test(lines[index])) { end = index; break; }
  return lines.slice(start, end).join('\n');
}

const lifecycle = fs.readFileSync(path.join(__dirname, '../../src/runtime/TmuxTaskLifecycle.ts'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../../src/clusterAgentRuntime.legacy.ts'), 'utf8');
const chain = [
  'import copy, json, os, re, sys, threading, time',
  'COLLECT_CALLS = 0',
  'MODE = sys.argv[1]',
  'RESULTS = []',
  'COLLECT_STARTED = threading.Event()',
  'RELEASE = threading.Event()',
  'S = json.loads(os.environ["ZZ_SCENARIO"])',
  'SCHEMA_VERSION = 3',
  'WORKER_GPU_SAMPLE_LOCK = threading.Lock()',
  'WORKER_GPU_SAMPLE_CACHE = {}',
  'WORKER_GPU_SAMPLE_EPOCH = "epoch-test-1"',
  'WORKER_GPU_SAMPLE_SEQ = 0',
  'def now_iso():',
  '    return "2026-10-19T12:35:06+00:00"',
  'def task_inventory(root, execution_only=False):',
  '    return [dict(row) for row in S["rows"]]',
  'def task_safe_path(root, value):',
  '    return value',
  'def task_option(key, field):',
  '    return "[]"',
  'def task_queue_session(root, worker):',
  '    return "q-" + worker',
  'def local_stop_tmux_inventory(root):',
  '    return []',
  'def collect_local_gpu():',
  '    global COLLECT_CALLS',
  '    COLLECT_CALLS += 1',
  '    if MODE == "slow":',
  '        COLLECT_STARTED.set()',
  '        RELEASE.wait(5)',
  '    return [{"index": "0", "memoryUsed": 1234, "utilization": 42}], ""',
  extractTopLevel(agent, 'api_worker_gpu'),
  extractTopLevel(lifecycle, 'task_execution_inventory'),
  'mode = sys.argv[1]',
  'if mode == "collect":',
  '    first = api_worker_gpu("/root")',
  '    second = api_worker_gpu("/root")',
  '    value = task_execution_inventory("/root")',
  '    mutated = value["gpuSample"]',
  '    mutated["generatedAt"] = "MUTATED"',
  '    mutated["seq"] = 999',
  '    again = task_execution_inventory("/root")',
  '    print(json.dumps({"collect": COLLECT_CALLS, "firstSeq": first["seq"], "secondSeq": second["seq"],',
  '        "epoch": first["epoch"], "sameTime": first["generatedAt"] == second["generatedAt"],',
  '        "carriedSeq": again["gpuSample"]["seq"],',
  '        "carriedTime": again["gpuSample"]["generatedAt"] == now_iso(),',
  '        "state": again["gpuSampleState"], "tasks": len(value["tasks"])}))',
  'elif mode == "slow":',
  '    sampler = threading.Thread(target=lambda: RESULTS.append(api_worker_gpu("/root")))',
  '    sampler.start()',
  '    started = COLLECT_STARTED.wait(5)',
  '    while_collecting = task_execution_inventory("/root")',
  '    finished_before_release = not RELEASE.is_set()',
  '    RELEASE.set()',
  '    sampler.join(5)',
  '    ready = task_execution_inventory("/root")',
  '    print(json.dumps({"started": bool(started), "sampleWhileCollecting": while_collecting["gpuSample"],',
  '        "stateWhileCollecting": while_collecting["gpuSampleState"], "finishedBeforeRelease": finished_before_release,',
  '        "collect": COLLECT_CALLS, "readyState": ready["gpuSampleState"], "readySeq": ready["gpuSample"]["seq"]}))',
  'else:',
  '    value = task_execution_inventory("/root")',
  '    print(json.dumps({"collect": COLLECT_CALLS, "gpuSample": value["gpuSample"], "state": value["gpuSampleState"], "tasks": len(value["tasks"])}))',
].join('\n');

const dir = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'zz-gpuchain-'));
const script = path.join(dir, 'gpu-sample-chain.py');
fs.writeFileSync(script, chain, 'utf8');
const scenario = {
  rows: [{ commandId: 'j1', projectId: 'p', workerId: 'w', outputDir: 'work/j1', tmuxPane: '%1', tmuxWindowId: '@1',
    tmuxSession: 's', dead: false, exitCode: null, phase: 'running', gpuId: '0' }],
};

function run(mode) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', script, mode], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, ZZ_SCENARIO: JSON.stringify(scenario) } });
  assert.equal(result.status, 0, 'python chain exit 0, stderr: ' + String(result.stderr || '').slice(0, 600));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

test('collected samples share the one-per-second cache and carry seq/epoch; the inventory carries them unchanged and collects nothing itself', () => {
  const out = run('collect');
  assert.equal(out.collect, 1, 'two api_worker_gpu reads plus two inventory reads collected nvidia-smi exactly once');
  assert.equal(out.firstSeq, 1, 'the collected sample is stamped with seq 1');
  assert.equal(out.secondSeq, 1, 'the shared cache copy keeps the same collected stamp, never re-stamps');
  assert.equal(out.epoch, 'epoch-test-1', 'the boot epoch rides on every collected sample');
  assert.equal(out.sameTime, true, 'the cache copy keeps the Worker-collected generatedAt');
  assert.equal(out.carriedSeq, 1, 'mutating one inventory copy cannot corrupt the cache or later carries');
  assert.equal(out.carriedTime, true, 'the carried sample keeps the original collected time');
  assert.equal(out.state, 'ready', 'a carried sample is honestly marked ready');
  assert.equal(out.tasks, 1, 'the execution inventory itself still works');
});

test('the fast inventory never waits on a blocked sampler: while nvidia-smi holds the lock it returns absent with a truthful state and finishes before the sampler does', () => {
  const out = run('slow');
  assert.equal(out.started, true, 'the sampler really entered nvidia-smi and holds the sample lock');
  assert.equal(out.sampleWhileCollecting, null, 'the inventory never waits for or half-copies a sample being collected');
  assert.equal(out.stateWhileCollecting, 'sampling', 'absence is honestly reported as sampling-in-progress, not as fresh data');
  assert.equal(out.finishedBeforeRelease, true, 'the inventory completed while the sampler was still blocked (ordering proof, not a wall-clock guess)');
  assert.equal(out.collect, 1, 'the inventory path triggered no extra nvidia-smi run');
  assert.equal(out.readyState, 'ready', 'after the sampler stores the frame the next inventory carries it');
  assert.equal(out.readySeq, 1, 'the stored sample keeps its collected seq stamp');
});

test('a fast inventory without any collected sample reports gpuSample=null without touching nvidia-smi', () => {
  const out = run('missing');
  assert.equal(out.gpuSample, null, 'a missing sample stays missing instead of sampling synchronously');
  assert.equal(out.state, 'missing', 'absence is honestly marked missing');
  assert.equal(out.collect, 0, 'the fast inventory path never calls nvidia-smi');
  assert.equal(out.tasks, 1, 'the inventory result is otherwise complete');
});
