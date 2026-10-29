import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

root = pathlib.Path(tempfile.mkdtemp(prefix='agent-legacy-'))
(root/'tmux').mkdir()
os.environ['TMUX_TMPDIR']=str(root/'tmux')
# 跨平台等价夹具：simple-sftp 是主仓的兄弟仓库；固定层级相对路径只在主 checkout 成立，
# 独立 worktree lane 中层级更深。按祖先链发现含 agent-lifecycle.py 的兄弟 simple-sftp，
# 主 checkout 解析结果与原 ../../../simple-sftp 完全一致，可用 SIMPLE_SFTP_REPO 显式覆盖。
def _vendor_repo_root():
    env = os.environ.get('SIMPLE_SFTP_REPO')
    if env:
        return pathlib.Path(env)
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents[1:]:
        candidate = parent / 'simple-sftp' / 'agent-lifecycle.py'
        if candidate.is_file():
            return candidate.parent
    raise FileNotFoundError('sibling simple-sftp repository with agent-lifecycle.py not found')
source = root / 'lifecycle.py'
source.write_bytes((_vendor_repo_root() / 'agent-lifecycle.py').read_bytes())
spec = importlib.util.spec_from_file_location('lifecycle', source)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
project = root / 'project'
project.mkdir()
install = root / 'runtime'
runtime = install / 'simple_cluster' / 'runtime'
runtime.mkdir(parents=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
params = dict(action='inspect', projectDir=str(project), installDir=str(install), mode='worker_telemetry', workerId='fixture-worker', host='127.0.0.1', port=port, condaEnv='',tmuxSession='fixture-worker-agent',tmuxWindow='agent')
conda = root / 'selected-conda'
(conda / 'bin').mkdir(parents=True)
# Conda may expose python and python3 as hard links, not symbolic links.
# /proc/<pid>/exe retains the launched name; realpath equality is insufficient.
shutil.copy2(os.path.realpath(sys.executable), conda / 'bin' / 'python')
os.link(conda / 'bin' / 'python', conda / 'bin' / 'python3')
params['condaEnv'] = str(root / 'training-env-not-installed')
contract = m.lifecycle_contract(params)
state = pathlib.Path(contract['stateDir'])
state.mkdir(parents=True)
session = {'agentInstallDir': str(install), 'agentStateDir': str(state), 'agentVersion':'fixture-old', 'startedAt':'fixture-start'}
(state / 'agent.session.json').write_text(json.dumps(session), encoding='utf-8')
(state / 'worker_availability.json').write_text(json.dumps({'schemaVersion':1,'workers':{'fixture-worker':{'workerId':'fixture-worker','totalGpus':0,'gpus':[]}}}), encoding='utf-8')
(state / 'events.jsonl').write_bytes(b'original historical bytes\n')
(state / 'worker_task_snapshot.json').write_text(json.dumps({'tasks':[
    {'commandId':'old-aoept-seed43','status':'stopped','pid':'%344','finishedAt':'2026-10-09T10:16:48Z','stopReason':'scheduler_aborted','stopSource':'user'},
    {'commandId':'old-aoept-seed44','status':'stopped','pid':'%345','finishedAt':'2026-10-09T10:16:53Z','stopReason':'scheduler_aborted','stopSource':'user'}]}),encoding='utf-8')
for name in ('actions', 'cluster_scheduler', 'live_output'):
    folder = state / name
    folder.mkdir()
    (folder/'retained.json').write_text('{"history":"retained"}',encoding='utf-8')
(state/'distributed_plan_queue.json').write_text(json.dumps({'schemaVersion':1,'jobs':[],'historicalPadding':'x'*(5*1024*1024)}),encoding='utf-8')
probe = '''import json
from http.server import BaseHTTPRequestHandler,HTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps(%r).encode();self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
HTTPServer(('127.0.0.1',%d),H).serve_forever()
''' % (dict(schemaVersion=1,projectRoot=str(project),agentInstallDir=str(install),agentStateDir=str(state),runtimeVersion='fixture-old',startedAt='fixture-start',mode='worker_telemetry'),port)
script = runtime / 'cluster_agent.py'
script.write_text(probe, encoding='utf-8')
(runtime / 'cluster_scheduler.py').write_bytes(b'fixture scheduler\n')
argv = [sys.executable,str(script),'serve','--project-dir',str(project),'--mode','worker_telemetry','--host','127.0.0.1','--port',str(port),'--worker-id','fixture-worker']
env = dict(os.environ,SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR=str(install),SIMPLE_EXPERIMENT_CONDA_ENV='legacy-training-environment')
platform = subprocess.Popen(['sleep','60'])
research = subprocess.Popen(['sleep','60'])
import shlex
launched=subprocess.run(['tmux','new-session','-d','-s',params['tmuxSession'],'-n','agent','exec env '+shlex.join(['SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR='+str(install),'SIMPLE_EXPERIMENT_CONDA_ENV=legacy-training-environment',*argv])],capture_output=True,text=True,timeout=3)
assert launched.returncode==0,launched.stderr
agent_pid=int(subprocess.check_output(['tmux','display-message','-p','-t',params['tmuxSession']+':agent','#{pane_pid}'],text=True))
class AgentHandle:
    pid=agent_pid
    def poll(self):return None if m.lifecycle_process(self.pid) else 0
    def wait(self,timeout):
        deadline=time.monotonic()+timeout
        while self.poll() is None and time.monotonic()<deadline:time.sleep(.01)
        assert self.poll() is not None
agent=AgentHandle()
try:
    deadline = time.monotonic()+3
    while not m.lifecycle_health(contract) and time.monotonic()<deadline:
        time.sleep(.02)
    assert agent.poll() is None
    original = {str(p.relative_to(state)):p.read_bytes() for p in state.rglob('*') if p.is_file()}
    before = m.lifecycle_control(params)
    migration = before['evidence']['migration']
    assert 'blocked' not in migration, migration
    assert migration['tmuxWindow']['session']==params['tmuxSession']
    assert migration['activeTasks']==[], migration
    assert original == {str(p.relative_to(state)):p.read_bytes() for p in state.rglob('*') if p.is_file()}
    # Research environments are task configuration, never auxiliary ownership.
    foreign_conda = root / 'foreign-conda'
    (foreign_conda / 'bin').mkdir(parents=True)
    shutil.copy2(conda / 'bin' / 'python', foreign_conda / 'bin' / 'python')
    other_config = m.lifecycle_control(dict(params, condaEnv=str(foreign_conda)))['evidence']['migration']
    assert 'blocked' not in other_config and other_config['tmuxWindow'] == migration['tmuxWindow'], other_config
    assert agent.poll() is None and platform.poll() is None
    availability_file=state/'worker_availability.json'
    availability_bytes=availability_file.read_bytes()
    availability_file.write_text(json.dumps({'workers':[{'workerId':'fixture-worker','totalGpus':0,'gpus':[]}]}),encoding='utf-8')
    assert 'blocked' not in m.lifecycle_control(params)['evidence']['migration']
    availability_file.write_bytes(availability_bytes)
    foreign=dict(params,workerId='another-worker')
    assert m.lifecycle_control(foreign)['evidence']['migration']['blocked']=='AGENT_LEGACY_WORKER_CONFLICT'
    for digest in ('', '0'*64):
        try:
            m.lifecycle_control(dict(params,action='migrate',migrationDigest=digest))
            raise AssertionError('unconfirmed migration')
        except m.AgentLifecycleError as e:
            assert e.code=='AGENT_MIGRATION_CONFIRM_REQUIRED'
        assert agent.poll() is None
    queue = state / 'worker_commands_fixture-worker.jsonl'
    queue.write_text(json.dumps({'commandId':'retained-command'})+'\n',encoding='utf-8')
    queued = m.lifecycle_control(params)['evidence']['migration']
    assert queued['activeTasks']==['retained-command']
    # New telemetry/actions while confirmation is open must not invalidate
    # the stable auxiliary ownership proof or consume the original queue.
    (state/'worker_task_snapshot.json').write_text(json.dumps({'tasks':[{'commandId':'running-research','status':'running'}]}),encoding='utf-8')
    (state/'actions'/'new-action.json').write_text('{"status":"queued"}',encoding='utf-8')
    refreshed=m.lifecycle_control(params)['evidence']['migration']
    assert refreshed['digest']==queued['digest'] and refreshed['activeTasks']==['running-research','retained-command']
    original = {str(p.relative_to(state)):p.read_bytes() for p in state.rglob('*') if p.is_file()}
    # Match the old Python boundary: pidfd APIs are unavailable; numeric PID
    # signalling is explicitly forbidden. Only the assigned tmux window may stop.
    saved_open=getattr(os,'pidfd_open',None);saved_send=getattr(m.signal,'pidfd_send_signal',None);saved_kill=os.kill
    if saved_open:delattr(os,'pidfd_open')
    if saved_send:delattr(m.signal,'pidfd_send_signal')
    os.kill=lambda *args: (_ for _ in ()).throw(AssertionError('PID signalling forbidden'))
    try:
        result=m.lifecycle_control(dict(params,action='migrate',migrationDigest=queued['digest']))
    finally:
        os.kill=saved_kill
        if saved_open:os.pidfd_open=saved_open
        if saved_send:m.signal.pidfd_send_signal=saved_send
    assert result['status']=='migrated' and result['closedTmuxWindow']['session']==params['tmuxSession']
    agent.wait(timeout=2)
    assert platform.poll() is None and research.poll() is None
    assert all((state/name).read_bytes()==raw for name,raw in original.items())
    assert json.loads((state/'agent.owner.json').read_text())==contract
    print(json.dumps({'assignedTmuxWindowClosed':True,'noPidfdOrPidSignal':True,'explicitDigestRequired':True,'pendingCommandsRetained':True,'activityDoesNotInvalidateOwnership':True,'stateBytesPreserved':True,'platformAlive':True,'researchAlive':True}))
finally:
    # These are fixture Popen handles only, never user or server processes.
    if agent.poll() is None:
        subprocess.run(['tmux','kill-window','-t',params['tmuxSession']+':agent'],capture_output=True,timeout=3)
        agent.wait(timeout=2)
    platform.terminate();platform.wait(timeout=2)
    research.terminate();research.wait(timeout=2)
