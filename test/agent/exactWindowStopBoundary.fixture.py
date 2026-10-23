"""Function-only stop routing and adversarial tmux model. No real process control."""
import os
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / '_helpers'))
from extractRuntimeFunctions import extract_runtime_functions

runtime = pathlib.Path(__file__).resolve().parents[2] / 'dist/runtime/cluster_agent.py'
windows, effects = {}, []
rpc_failed = False

def forbidden(*args, **kwargs):
    raise AssertionError(('forbidden process/session control', args))

def native_inventory(root, **kwargs):
    return [dict(commandId=row['command'], projectId=row['project'], workerId=row.get('worker', 'worker'), tmuxWindowId=wid)
            for wid, row in windows.items() if row['kind'] == 'native']

def legacy_inventory(root):
    return [dict(command=row['command'], project=row['project'], window=wid)
            for wid, row in windows.items() if row['kind'] == 'legacy']

def queue_rpc(root, worker, action, payload, **kwargs):
    assert action == 'cancel' and kwargs.get('ensure') is True
    effects.append(('cancel', payload['targetCommandId']))
    if rpc_failed:
        raise RuntimeError('fixture controller unavailable')
    for wid, row in list(windows.items()):
        if row['kind'] == 'native' and row['command'] == payload['targetCommandId'] and row['project'] == payload['projectId']:
            del windows[wid]
    return {'ok': True}

def task_tmux(args):
    assert args[0] == 'kill-window' and args[1] == '-t' and args[2].startswith('@'), args
    effects.append(('kill-window', args[2]))
    windows.pop(args[2], None)
    return ''

def terminal(root, action, operation_id, op_id, status, message, extra=None, **kwargs):
    return {'status': status, 'message': message, **(extra or {})}

safe_os = types.SimpleNamespace(**vars(os))
safe_os.kill = forbidden
safe_os.environ = {**os.environ, 'SIMPLE_EXPERIMENT_WORKER_ID': 'worker'}
ns = dict(os=safe_os, TASK_LIFECYCLE_PROTOCOL=2, action_plan_file=lambda body: str(body.get('planFile') or ''),
          terminal_action=terminal, task_inventory=native_inventory, local_stop_tmux_inventory=legacy_inventory,
          task_queue_rpc=queue_rpc, task_tmux=task_tmux,
          _execute_worker_command_unfenced=lambda *args: {'status': 'legacy-routed'})
extract_runtime_functions(runtime, ['stop_scheduler_operation', 'task_stop', 'execute_worker_command',
    '_reap_zombie_scheduler_sessions', '_reap_orphan_gpu_sessions'], namespace=ns)

def reset(kind='native'):
    global rpc_failed
    rpc_failed = False
    effects.clear()
    windows.clear()
    windows.update({'@1': {'kind': kind, 'command': 'original', 'project': 'project'},
                    '@2': {'kind': 'native', 'command': 'unrelated', 'project': 'project'}})

request = dict(targetOperationId='original', operationId='stop-original', opId='stop-original',
               workerId='worker', projectId='project', planFile='plans/current.yaml',
               pid=123, tmuxSession='unrelated', planRevision='changed', codeFingerprint='changed')
def run_native():
    global rpc_failed
    reset()
    value = ns['stop_scheduler_operation']('/fixture', request)
    assert value['status'] == 'completed' and value['matchedOperations'] == ['original'], value
    assert value['terminatedWindowIds'] == ['@1'] and value['terminatedPids'] == [], value
    assert effects == [('cancel', 'original')] and set(windows) == {'@2'}, (effects, windows)

def run_identity():
    global rpc_failed
    for change in ({'workerId': 'foreign'}, {'operationId': 'original', 'opId': 'original'},
                   {'targetOperationId': '', 'remoteOperationId': '', 'targetCommandId': ''}):
        reset()
        value = ns['stop_scheduler_operation']('/fixture', {**request, **change})
        assert value['status'] == 'failed' and effects == [] and set(windows) == {'@1', '@2'}, value

    reset()
    windows['@1']['project'] = 'foreign-project'
    value = ns['stop_scheduler_operation']('/fixture', request)
    assert value['status'] == 'failed' and not effects and '@1' in windows, value
    assert ns['_reap_zombie_scheduler_sessions']('/fixture', [], 'old-sch-name') == []
    assert ns['_reap_orphan_gpu_sessions']('/fixture', True) == []
    assert '@1' in windows and not effects


def run_bridge():
    global rpc_failed
    # Current stop entry points cannot depend on a scientific result-path policy.
    reset()
    value = ns['execute_worker_command']('/fixture', {'action': 'stop-worker-task', 'targetCommandId': 'original',
        'operationId': 'stop-original', 'workerId': 'worker', 'projectId': 'project'}, 'worker')
    assert value['status'] == 'completed' and effects[0] == ('cancel', 'original'), (value, effects)


def run_fallback():
    global rpc_failed
    # A broken controller still allows closing exact observed windows; no PID fallback.
    for kind in ('native', 'legacy'):
        reset(kind)
        rpc_failed = True
        value = ns['stop_scheduler_operation']('/fixture', request)
        assert value['status'] == 'completed' and set(windows) == {'@2'}, (kind, value, windows)
        assert effects == [('cancel', 'original'), ('kill-window', '@1')], effects

    reset('legacy')
    def changed_owner(*args, **kwargs):
        windows['@1']['project'] = 'foreign-project'
        raise RuntimeError('controller unavailable during identity change')
    ns['task_queue_rpc'] = changed_owner
    try:
        value = ns['stop_scheduler_operation']('/fixture', request)
        assert value['status'] == 'failed' and '@1' in windows and not effects, (value, windows, effects)
    finally:
        ns['task_queue_rpc'] = queue_rpc


# Session UI controls close only the complete set of user-confirmed immutable tabs.
model = {'@3': ('service', '%3'), '@4': ('console', '%4')}
mutations = []
query_count = 0
race = False
def session_run(args, **kwargs):
    global query_count
    assert args[0] == 'tmux'
    command = args[1]
    stdout, stderr, status = '', '', 0
    if command == 'list-windows':
        query_count += 1
        if race == 'window' and query_count == 3:
            model['@99'] = ('new-unconfirmed-window', '%99')
        stdout = '\n'.join('$1|' + wid + '|' + row[0] for wid, row in model.items())
    elif command == 'list-panes':
        if race == 'pane' and query_count >= 3 and args[3] == '@3':
            model['@3'] = (model['@3'][0], '%99')
        stdout = model[args[3]][1]
    elif command == 'kill-window':
        mutations.append(args[3])
        model.pop(args[3])
    elif command == 'has-session':
        if not model:
            status, stderr = 1, "can't find session: $1"
    else:
        forbidden(args)
    return types.SimpleNamespace(stdout=stdout, stderr=stderr, returncode=status)


def run_session():
    global query_count, race
    session_ns = dict(os=safe_os, subprocess=types.SimpleNamespace(run=session_run))
    extract_runtime_functions(runtime, ['manage_tmux_session_response'], namespace=session_ns)
    payload = dict(sessionAction='close', session='configured', confirm=True, identities=[
        dict(session='configured', windowId='@3', windowName='service', paneIds=['%3']),
        dict(session='configured', windowId='@4', windowName='console', paneIds=['%4'])])
    value, status = session_ns['manage_tmux_session_response'](payload)
    assert status == 200 and value['verified'] is True and mutations == ['@3', '@4'], (value, mutations)
    model.update({'@3': ('service', '%3'), '@4': ('console', '%4')})
    mutations.clear()
    query_count, race = 0, "window"
    value, status = session_ns['manage_tmux_session_response'](payload)
    assert status == 200 and value['ok'] is False and 'window set changed' in value['error'] and mutations == [] and '@99' in model, (value, mutations, model)
    model.clear()
    model.update({'@3': ('service', '%3'), '@4': ('console', '%4')})
    query_count, race = 0, 'pane'
    value, status = session_ns['manage_tmux_session_response'](payload)
    assert status == 200 and value['ok'] is False and 'pane identities changed' in value['error'] and mutations == [], (value, mutations, model)

selected = sys.argv[1] if len(sys.argv) > 1 else 'all'
for name, run in [('native', run_native), ('identity', run_identity), ('bridge', run_bridge), ('fallback', run_fallback), ('session', run_session)]:
    if selected in ('all', name):
        run()
        print(name + ' ok')
print('exact stop boundaries ok')
