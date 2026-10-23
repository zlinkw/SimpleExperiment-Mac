import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

# 跨平台等价夹具：simple-sftp 是主仓的兄弟仓库；固定层级相对路径只在主 checkout 成立，
# 独立 worktree lane 中层级更深。按祖先链发现含 agent-lifecycle.py 的兄弟 simple-sftp，
# 主 checkout 解析结果与原 ../../../simple-sftp 完全一致，可用 SIMPLE_SFTP_REPO 显式覆盖。
def _vendor_repo_root():
    if len(sys.argv) > 1:
        return pathlib.Path(sys.argv[1])
    env = os.environ.get('SIMPLE_SFTP_REPO')
    if env:
        return pathlib.Path(env)
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents[1:]:
        candidate = parent / 'simple-sftp' / 'agent-lifecycle.py'
        if candidate.is_file():
            return candidate.parent
    raise FileNotFoundError('sibling simple-sftp repository with agent-lifecycle.py not found')
vendor_source = _vendor_repo_root() / 'agent-lifecycle.py'
root = pathlib.Path(tempfile.mkdtemp(prefix='agent-service-'))
(root/'tmux').mkdir()
os.environ['TMUX_TMPDIR']=str(root/'tmux')
# Each real child imports the unchanged controller bytes from native Linux
# storage, avoiding repeated WSL cross-filesystem reads in the 10 second budget.
source = root / 'lifecycle.py'
source.write_bytes(vendor_source.read_bytes())
assert source.read_bytes() == vendor_source.read_bytes()
spec = importlib.util.spec_from_file_location('lifecycle', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
agent_source = (pathlib.Path(__file__).resolve().parents[2] / 'src' / 'clusterAgentRuntime.legacy.ts').read_text(encoding='utf-8')
health_source = agent_source.split('def api_health(root, mode="realtime"):',1)[1].split('\ndef api_version',1)[0]
def forbidden_environment_probe(*args):
    raise AssertionError('Agent health started a research environment probe')
health_scope = dict(scheduler_dependency_health=forbidden_environment_probe,
    read_runtime_json_cached=lambda *args: {}, path_for=lambda *args:'fixture', inspect_agent=lambda root:{'running':True},
    iso_age_seconds=lambda value:0, now_iso=lambda:'fixture-time', agent_install_dir=lambda root:'runtime', agent_dir=lambda root:'state',
    gpu_collector_state_root=lambda root:'/fixture/worker-state',
    SCHEMA_VERSION=1, AGENT_VERSION='fixture', API_VERSION='1', RUNTIME_VERSION='fixture', PLUGIN_VERSION='fixture',
    AGENT_LIFECYCLE_IDENTITY={}, TASK_SCHEDULER_UPDATE_ERROR='',
    task_scheduler_runtime_report=lambda root, worker: {'protocol': 1, 'status': 'absent', 'workerId': worker}, os=os)
# Extract only the real health function; never import/execute the production module.
exec('def api_health(root, mode="realtime"):'+health_source, health_scope)
health = health_scope['api_health'](str(root), 'worker_telemetry')
assert health['schedulerDependencies']['checked'] is False
assert health['schedulerRuntime']['status'] == 'absent'
assert 'ok' not in health['schedulerDependencies'], 'unchecked environment was claimed valid'
project = root / 'project'
project.mkdir()
install = root / 'runtime'
runtime = install / 'simple_cluster' / 'runtime'
runtime.mkdir(parents=True)
probe = '''import argparse, importlib.util, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
spec=importlib.util.spec_from_file_location("lifecycle",%r)
l=importlib.util.module_from_spec(spec);spec.loader.exec_module(l)
p=argparse.ArgumentParser();p.add_argument("serve");p.add_argument("--project-dir");p.add_argument("--host");p.add_argument("--port",type=int);p.add_argument("--mode");p.add_argument("--worker-id");a=p.parse_args()
lock,identity=l.lifecycle_service_guard(a,"fixture-v1")
identity["workerStateDir"]=os.environ.get("SIMPLE_EXPERIMENT_WORKER_STATE_DIR")
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get("X-Simple-Agent-Token","")!=os.environ.get("SIMPLE_EXPERIMENT_AGENT_TOKEN",""):self.send_response(403);self.end_headers();return
  body=json.dumps({"schemaVersion":1,"runtimeVersion":"fixture-v1","agentLifecycleProtocol":1,"agentIdentity":identity,"schedulerRuntime":{"protocol":1,"status":"absent","workerId":a.worker_id,"secret":"must-not-leak","port":45678}}).encode();self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
HTTPServer((a.host,a.port),H).serve_forever()
''' % str(source)
(runtime / 'cluster_agent.py').write_text(probe, encoding='utf-8')
(runtime / 'cluster_scheduler.py').write_text('# CPU fixture scheduler\n', encoding='utf-8')
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    port = sock.getsockname()[1]
params = dict(action='inspect', projectDir=str(project),installDir=str(install),mode='worker_telemetry',workerId='container-gpu',
              tmuxSession='user-worker-container-gpu-agent',tmuxWindow='agent',sessionPrefix='user',
              host='127.0.0.1',port=port,condaEnv=str(root/'missing-training-env'),agentToken='fixture-credential',expectedVersion='fixture-v1',files={
                  name:hashlib.sha256((runtime/name).read_bytes()).hexdigest() for name in ('cluster_agent.py','cluster_scheduler.py')})
tree = sorted(str(p) for p in root.rglob('*'))
assert module.lifecycle_control(params)['status']=='absent'
assert tree==sorted(str(p) for p in root.rglob('*')), 'inspect wrote files'
legacy_contract = module.lifecycle_contract(params)
legacy_state = pathlib.Path(legacy_contract['stateDir'])
legacy_state.mkdir(parents=True)
legacy_file = legacy_state / 'agent.session.json'
legacy_bytes = json.dumps({'agentVersion':'fixture-old','agentStateDir':str(legacy_state),'token':'must-not-be-returned'}).encode()
legacy_file.write_bytes(legacy_bytes)
before_legacy = sorted((str(p),p.read_bytes()) for p in legacy_state.rglob('*') if p.is_file())
legacy = module.lifecycle_control(params)
assert legacy['ok'] is False and legacy['code'] == 'AGENT_LEGACY_STATE_UNVERIFIED'
assert legacy['evidence']['metadata'][0]['sha256'] == hashlib.sha256(legacy_bytes).hexdigest()
assert 'must-not-be-returned' not in json.dumps(legacy)
assert before_legacy == sorted((str(p),p.read_bytes()) for p in legacy_state.rglob('*') if p.is_file())
# Keep the legacy fixture intact; create the independent service in a different
# explicit fixture project, without clearing or adopting any old metadata.
project = root / 'fresh-project'
project.mkdir()
params['projectDir'] = str(project)
params['stateDir'] = str(root / 'custom-agent-state')
params['workerStateDir'] = str(root / 'custom-worker-state')
platform = subprocess.Popen(['sleep','60'])
research = subprocess.Popen(['sleep','60'])
agent = None
saved_open=getattr(os,'pidfd_open',None);saved_send=getattr(module.signal,'pidfd_send_signal',None);saved_kill=os.kill
if saved_open:delattr(os,'pidfd_open')
if saved_send:delattr(module.signal,'pidfd_send_signal')
os.kill=lambda *args: (_ for _ in ()).throw(AssertionError('PID signalling forbidden'))
other_window=None
old_server_window=None
try:
    # An existing tmux server may carry a previous shell's GPU environment.
    # New auxiliary windows must preserve this launch's container binding.
    stale_env=dict(os.environ,CUDA_VISIBLE_DEVICES='old-shell-device',NVIDIA_VISIBLE_DEVICES='old-container')
    started=subprocess.run(['tmux','new-session','-d','-s','preexisting-shell','-n','keep','exec sleep 60'],env=stale_env,capture_output=True,text=True,timeout=3)
    assert started.returncode==0,started.stderr
    old_server_window='preexisting-shell:keep'
    def concurrent_prepare(_):
        try:
            return module.lifecycle_control(dict(params,action='ensure'))
        except module.AgentLifecycleError as error:
            assert error.code=='AGENT_LIFECYCLE_BUSY'
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts=list(pool.map(concurrent_prepare, range(2)))
    first = next(row for row in receipts if row)
    assert len({row['identity']['pid'] for row in receipts if row})==1
    agent = first['identity']['pid']
    assert first['reused'] is False
    assert first['identity']['stateDir'] == params['stateDir']
    assert first['identity']['workerStateDir'] == params['workerStateDir']
    again = module.lifecycle_control(dict(params,action='ensure'))
    assert again['reused'] is True and again['identity']['pid']==agent
    assert again['schedulerRuntime']=={'protocol':1,'status':'absent','workerId':'container-gpu'}
    assert 'must-not-leak' not in json.dumps(again)
    changed_env = module.lifecycle_control(dict(params,action='ensure',condaEnv='another-task-environment'))
    assert changed_env['reused'] is True and changed_env['identity']['pid']==agent
    before = (pathlib.Path(first['contract']['stateDir'])/'agent.owner.json').read_bytes()
    assert b'fixture-credential' not in before
    machine = module.lifecycle_machine
    module.lifecycle_machine = lambda:'cpu-backup-different-container'
    try:
        module.lifecycle_control(params)
        raise AssertionError('CPU container adopted GPU state')
    except module.AgentLifecycleError as e:
        assert e.code=='AGENT_STATE_OWNER_CONFLICT'
    finally:
        module.lifecycle_machine=machine
    assert (pathlib.Path(first['contract']['stateDir'])/'agent.owner.json').read_bytes()==before
    try:
        module.lifecycle_control(dict(params,action='ensure',expectedVersion='fixture-v2'))
        raise AssertionError('version mismatch reused')
    except module.AgentLifecycleError as e:
        assert e.code=='AGENT_RUNNING_VERSION_MISMATCH'
    assert module.lifecycle_process(agent)
    try:
        module.lifecycle_control(dict(params,action='restart',files=dict(params['files'],**{'cluster_agent.py':'0'*64})))
        raise AssertionError('bad runtime stopped healthy service')
    except module.AgentLifecycleError as e:
        assert e.code=='AGENT_RUNTIME_HASH_MISMATCH'
    assert module.lifecycle_process(agent)
    state = pathlib.Path(first['contract']['stateDir'])
    # A sibling window and GPU sessions must survive every Agent restart/stop.
    other_window=module.lifecycle_tmux_run(['new-window','-d','-P','-F','#{window_id}','-t','='+params['tmuxSession'],'-n','research-watch','exec sleep 60'])
    gpu_session='user-gpu-0'
    module.lifecycle_tmux_run(['new-session','-d','-s',gpu_session,'exec sleep 60'])
    for status in ('running','queued','accepted','stop_requested','unknown',''):
        (state/'worker_task_snapshot.json').write_text(json.dumps({'tasks':[{'commandId':'retained-command','status':status}]}),encoding='utf-8')
        assert module.lifecycle_control(params)['activeTasks']==['retained-command']
        original=(state/'worker_task_snapshot.json').read_bytes()
        restarted=module.lifecycle_control(dict(params,action='restart'))
        assert restarted['identity']['pid']!=agent and not module.lifecycle_process(agent)
        agent=restarted['identity']['pid']
        assert (state/'worker_task_snapshot.json').read_bytes()==original
        assert platform.poll() is None and research.poll() is None
        assert module.lifecycle_tmux_run(['display-message','-p','-t',other_window,'#{window_name}'])=='research-watch'
        assert module.lifecycle_tmux_run(['list-windows','-t','='+gpu_session,'-F','#{session_name}'])==gpu_session
    terminal_bytes=json.dumps({'tasks':[{'commandId':'old-stopped-job','status':'stopped','finishedAt':'old','stopReason':'scheduler_aborted'},
                                      {'commandId':'old-canceled-job','status':'canceled','finishedAt':'old'}]}).encode()
    (state/'worker_task_snapshot.json').write_bytes(terminal_bytes)
    assert module.lifecycle_control(params)['activeTasks']==[]
    (state/'distributed_plan_queue.json').write_text(json.dumps({'jobs':[{'commandId':'queued-durable','status':'queued'}]}),encoding='utf-8')
    assert module.lifecycle_control(params)['activeTasks']==['queued-durable']
    queued_bytes=(state/'distributed_plan_queue.json').read_bytes()
    (runtime/'cluster_agent.py').write_text(probe.replace('fixture-v1','fixture-v2'),encoding='utf-8')
    upgraded=dict(params,expectedVersion='fixture-v2',files={name:hashlib.sha256((runtime/name).read_bytes()).hexdigest() for name in params['files']})
    restarted=module.lifecycle_control(dict(upgraded,action='restart'))
    assert restarted['runningVersion']=='fixture-v2'
    assert restarted['identity']['pid']!=agent
    agent=restarted['identity']['pid']
    assert platform.poll() is None
    assert research.poll() is None
    assert (state/'distributed_plan_queue.json').read_bytes()==queued_bytes
    assert (state/'worker_task_snapshot.json').read_bytes()==terminal_bytes
    actual_window=restarted['tmuxWindow']
    try:
        module.lifecycle_close_tmux(params,dict(actual_window,windowId='@999999'))
        raise AssertionError('changed window was closed')
    except module.AgentLifecycleError as e:
        assert e.code=='AGENT_TMUX_WINDOW_CHANGED'
    assert module.lifecycle_process(agent)
    # Lost HTTP health cannot obstruct closing the assigned window.
    health_function=module.lifecycle_health
    unhealthy_pid=agent
    module.lifecycle_health=lambda *args: {} if module.lifecycle_process(unhealthy_pid) else health_function(*args)
    assert module.lifecycle_control(params)['status']=='unhealthy'
    recovered=module.lifecycle_control(dict(upgraded,action='restart'))
    assert not module.lifecycle_process(unhealthy_pid)
    agent=recovered['identity']['pid']
    module.lifecycle_health=health_function
    (state/'worker_task_snapshot.json').write_bytes(b'{corrupt activity')
    assert module.lifecycle_control(params)['activeTasks']==['unverified-activity:worker_task_snapshot.json','queued-durable']
    original=(state/'worker_task_snapshot.json').read_bytes()
    assert module.lifecycle_control(dict(params,action='stop'))['status']=='stopped'
    assert not module.lifecycle_process(agent)
    assert platform.poll() is None
    assert research.poll() is None
    assert (state/'worker_task_snapshot.json').read_bytes()==original
    (state/'worker_task_snapshot.json').write_text(json.dumps({'tasks':[{'commandId':'queued-original','status':'queued'}]}),encoding='utf-8')
    original=(state/'worker_task_snapshot.json').read_bytes()
    prepared=module.lifecycle_control(dict(upgraded,action='ensure'))
    agent=prepared['identity']['pid']
    assert (state/'worker_task_snapshot.json').read_bytes()==original
    assert (state/'distributed_plan_queue.json').read_bytes()==queued_bytes
    assert research.poll() is None and platform.poll() is None
    print(json.dumps({'firstStartInAssignedTmux':True,'reused':True,'ownedWindowRestart':True,'cpuConflictRejected':True,'platformAlive':True,'researchAlive':True,'siblingAndGpuWindowsPreserved':True,'changedWindowProtected':True,'noPidfdOrPidSignal':True,'zeroWriteInspect':True,'activeTasksNeverBlockRestart':True,'queueBytesPreserved':True,'unhealthyRecovered':True,'corruptActivityNotGate':True,'missingResearchEnvAllowed':True,'changedResearchEnvReused':True,'healthWithoutEnvironmentProbe':True}))
finally:
    # Only fixture processes created in this script; no user/platform target touched.
    fixture_window=module.lifecycle_tmux_window(params)
    if fixture_window:
        module.lifecycle_close_tmux(params,fixture_window)
    os.kill=saved_kill
    if saved_open:os.pidfd_open=saved_open
    if saved_send:module.signal.pidfd_send_signal=saved_send
    if other_window:module.lifecycle_tmux_run(['kill-window','-t',other_window])
    if 'gpu_session' in globals():module.lifecycle_tmux_run(['kill-window','-t',gpu_session+':0'])
    if old_server_window:module.lifecycle_tmux_run(['kill-window','-t',old_server_window])
    platform.terminate()
    platform.wait(timeout=2)
    research.terminate()
    research.wait(timeout=2)
