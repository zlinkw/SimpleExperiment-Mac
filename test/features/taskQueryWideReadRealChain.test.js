// Real remote chain evidence for item 39: the worker-wide task_query (empty or
// unselected queries) performs artifact-manifest and dead-pane log reads for EVERY
// inventory row, including a solidified completion. Only the precise selected+
// observation interface stays bound to the named jobs.
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

const source = fs.readFileSync(path.join(__dirname, '../../dist/runtime/cluster_agent.py'), 'utf8');
const chain = [
  'import json, re, base64, os, sys',
  'S = json.loads(os.environ["ZZ_SCENARIO"])',
  'C = {"manifest": [], "logs": [], "taskReadJob": 0}',
  'def task_inventory(root, execution_only=False):',
  '    return [dict(row) for row in S["rows"]]',
  'def task_safe_path(root, value):',
  '    return value',
  'def now_iso():',
  '    return "2026-10-19T12:35:06+00:00"',
  'def task_manifest_observation(root, job):',
  '    C["manifest"].append(job["commandId"])',
  '    return {"runId": job["commandId"], "identityMatches": True, "present": True, "verified": True,',
  '            "artifactsComplete": True, "status": "completed", "exitCode": 0}',
  'def task_log_diagnostics(root, job, row=None, terminal=False, binding=None):',
  '    if terminal: C["logs"].append(job["commandId"])',
  '    return {"schemaVersion": 1, "commandId": job["commandId"], "runId": job["commandId"], "state": "clear", "count": 0, "scanComplete": True}',
  'def task_option(key, field):',
  '    return "[]"',
  'def task_queue_session(root, worker):',
  '    return "q-" + worker',
  'def task_tmux(args):',
  '    return ""',
  'def task_read_job(pane):',
  '    C["taskReadJob"] += 1',
  '    return {}',
  'def local_stop_tmux_inventory(root):',
  '    return []',
  'def task_memory_scheduler_capability(root):',
  '    return 1',
  extractTopLevel(source, 'task_public_observation'),
  extractTopLevel(source, 'task_query'),
  'mode = sys.argv[1]',
  'if mode == "wide": value = task_query("/root", [])',
  'elif mode == "unselected": value = task_query("/root", S["selectors"])',
  'else: value = task_query("/root", S["selectors"], selected_only=True, observation_only=True)',
  'print(json.dumps({"manifest": C["manifest"], "logs": C["logs"], "taskReadJob": C["taskReadJob"],',
  '                  "tasks": sorted(str(task.get("commandId") or "") for task in value["tasks"])}))',
].join('\n');

const dir = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'zz-chain-'));
const script = path.join(dir, 'task-query-chain.py');
fs.writeFileSync(script, chain, 'utf8');

const scenario = {
  rows: [
    { projectId: 'p', commandId: 'solid', workerId: 'w', outputDir: 'work/solid', tmuxWindowId: '@1', tmuxPane: '%1',
      tmuxSession: 's', gpuId: '', exitCode: 0, dead: true, phase: 'running', logPath: 'logs/solid.log' },
    { projectId: 'p', commandId: 'live', workerId: 'w', outputDir: 'work/live', tmuxWindowId: '@2', tmuxPane: '%2',
      tmuxSession: 's', gpuId: '', exitCode: null, dead: false, phase: 'running', logPath: 'logs/live.log' },
  ],
  selectors: [{ projectId: 'p', commandId: 'live', workerId: 'w', outputDir: 'work/live' }],
};

function run(mode) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', script, mode], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, ZZ_SCENARIO: JSON.stringify(scenario) } });
  assert.equal(result.status, 0, 'python chain exit 0, stderr: ' + String(result.stderr || '').slice(0, 600));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

test('the real task_query with empty queries reads the solidified job manifest and dead-pane log (counter-example for the wide fallback)', () => {
  const out = run('wide');
  assert.ok(out.manifest.includes('solid'), 'GET-wide task_query(root, []) reads the artifact manifest of every row including the solidified job: ' + JSON.stringify(out.manifest));
  assert.ok(out.logs.includes('solid'), 'and reads dead-pane logs for the solidified job: ' + JSON.stringify(out.logs));
});

test('the real task_query with named selectors but selected_only=false still reads every inventory row', () => {
  const out = run('unselected');
  assert.ok(out.manifest.includes('solid'), 'naming only the live job does not bound the reads: ' + JSON.stringify(out.manifest));
  assert.ok(out.logs.includes('solid'), 'the solidified dead-pane log is still read: ' + JSON.stringify(out.logs));
});

test('the precise selected+observation interface reads only the named live job (the lane the automatic round must use)', () => {
  const out = run('selected');
  assert.deepEqual(out.manifest, ['live'], 'artifact reads stay bound to the selector');
  assert.deepEqual(out.logs, [], 'the solidified job receives no log read');
});
