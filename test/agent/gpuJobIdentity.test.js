const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('GPU telemetry reads job identity and both tmux launch paths forward it without exposing other environment values', () => {
  const scope = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'simpleex-gpu-identity-')));
  const script = path.join(scope, 'fixture.py');
  const runtime = path.resolve(__dirname, '../../dist/runtime/cluster_agent.py');
  fs.writeFileSync(script, String.raw`import ast, io, os, csv, shlex, subprocess, types, time, builtins
from unittest.mock import patch
with open(${JSON.stringify(runtime)}, encoding='utf-8') as f:
    tree = ast.parse(f.read())
names = {'collect_local_gpu', 'start_job_in_gpu_pane', 'start_simple_tmux_command'}
selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(selected) == 3
exec(compile(ast.Module(body=selected, type_ignores=[]), 'extracted-functions', 'exec'))
SYSTEM_GPU_PROCESSES = set()
now_iso = lambda: '2026-10-10T00:00:00Z'
def fake_run(args, **kwargs):
    if args[0] == 'nvidia-smi':
        stdout = '0,uuid,card,500,24000,20,50' if '--query-gpu=' in args[1] else 'uuid,123,python,500'
    elif args[0] == 'ps': stdout = '123 shared python custom.py'
    else: raise AssertionError(args)
    return types.SimpleNamespace(returncode=0, stdout=stdout, stderr='')
with patch.object(subprocess, 'run', fake_run), patch.object(os, 'readlink', return_value='/server/zlk/project'), patch.object(builtins, 'open', return_value=io.BytesIO(b'SIMPLE_EXPERIMENT_MANAGED_JOB=1\0SIMPLE_EXPERIMENT_JOB_COMMAND_ID=issued-command\0SIMPLE_EXPERIMENT_JOB_PROJECT_ID=local-project\0SECRET=value\0')):
    rows, error = collect_local_gpu()
assert not error
process = rows[0]['processes'][0]
assert process['jobCommandId'] == 'issued-command'
assert process['jobProjectId'] == 'local-project'
assert process['cwd'] == '/server/zlk/project' and process['pluginManaged'] is True
assert 'SECRET' not in process and 'value' not in str(process)

calls, lines = [], []
def tmux_run(args, **kwargs):
    calls.append(args)
    return types.SimpleNamespace(returncode=0, stdout='%42', stderr='')
write_atomic_text = lambda *args: None
simple_conda_env_name = lambda env: ''
simple_conda_activation_script = lambda env: 'true'
tmux_session_alive = lambda *args: True
tmux_pane_pid = lambda *args: 123
_is_main_shell_target = lambda *args: False
_build_tmux_error_context = lambda *args, **kwargs: 'mock'
_send_tmux_line = lambda session, line, *args, **kwargs: lines.append(line) or 0
_wait_tmux_ready = lambda *args, **kwargs: True
_truncate_text = lambda text, count: text[:count]
env = {'SIMPLE_EXPERIMENT_MANAGED_JOB': '1', 'SIMPLE_EXPERIMENT_JOB_COMMAND_ID': 'issued-command', 'SIMPLE_EXPERIMENT_JOB_PROJECT_ID': 'local-project'}
with patch.object(subprocess, 'run', tmux_run), patch.object(os, 'makedirs'), patch.object(os.path, 'isdir', return_value=True), patch.object(time, 'sleep', return_value=None):
    assert start_job_in_gpu_pane('gpu-0', ['python', 'custom.py'], '/server/zlk/project', env, 'task.log', 'task.exit') == '%42'
    cmd = next(args[-1] for args in calls if args[:2] == ['tmux', 'new-window'])
    assert 'export SIMPLE_EXPERIMENT_JOB_COMMAND_ID=issued-command;' in cmd
    assert 'export SIMPLE_EXPERIMENT_JOB_PROJECT_ID=local-project;' in cmd
    tmux_session_alive = lambda *args: False
    start_simple_tmux_command('simple-sch-test', ['python', 'custom.py'], '/server/zlk/project', '', env)
    assert 'export SIMPLE_EXPERIMENT_JOB_COMMAND_ID=issued-command' in lines
    assert 'export SIMPLE_EXPERIMENT_JOB_PROJECT_ID=local-project' in lines
print('verified GPU job identity and tmux environment forwarding')
`, 'utf8');
  try {
    const run = spawnSync('python', ['-X', 'utf8', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /verified GPU job identity/);
  } finally {
    // Preserve the generated fixture by an exact, verified move, never permanent deletion.
    const parent = fs.realpathSync(path.dirname(script));
    const info = fs.lstatSync(script);
    assert.equal(parent, scope); assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false);
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const record = { type: 'file', source: script, sourceRoot: scope, destinationRoot: path.join(scope, 'clean_dir'),
      reason: 'completed bounded Python fixture', dependencyRisk: 'none', discoveredAt: new Date().toISOString(), bytes: info.size, sha256: digest(script) };
    assert.equal(fs.existsSync(record.destinationRoot), false);
    fs.mkdirSync(record.destinationRoot);
    const destination = path.join(record.destinationRoot, 'fixture.py');
    assert.equal(fs.realpathSync(path.dirname(destination)), record.destinationRoot);
    assert.equal(fs.existsSync(destination), false); assert.equal(digest(script), record.sha256);
    assert.equal(fs.lstatSync(script).size, record.bytes); assert.equal(fs.lstatSync(script).isSymbolicLink(), false);
    fs.renameSync(script, destination);
    assert.equal(fs.existsSync(script), false); assert.equal(digest(destination), record.sha256);
    fs.writeFileSync(path.join(record.destinationRoot, 'MANIFEST.md'), JSON.stringify({ ...record, destination }) + '\n', 'utf8');
  }
});
