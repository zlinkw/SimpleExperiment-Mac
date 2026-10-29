import ast, hashlib, json, os, pathlib, re, sys, threading, tempfile

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(source)
ns = dict(hashlib=hashlib, json=json, os=os, re=re, threading=threading)
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith('task_log_')], type_ignores=[]), 'log-functions', 'exec'), ns)
new, feed, report = ns['task_log_new'], ns['task_log_feed'], ns['task_log_report']
def marker(command, event, phase='initialization'):
    return '[simple-experiment-runtime-log] ' + json.dumps(dict(commandId=command,event=event,phase=phase))+'\n'
def parse(text, command='command', chunk=13):
    state=new(command,'raw.log')
    data=text.encode('utf-8')
    for i in range(0,len(data),chunk): feed(state,data[i:i+chunk])
    feed(state,b'',True)
    return report(state,True,True)
normal=marker('command','begin')+'WARNING: zero predicted classes; metric=0\nProcess dataset: 100\nError budget: 0; RuntimeError counter=0\n[simple-adapter] Prefer environment nvJitLink over system CUDA\n进度 300/300\r'+marker('command','end')
assert parse(normal)['state']=='clear'
# NumExpr prints errors without a trailing newline, joining the runtime marker.
numeric_error='Error.  nthreads cannot be larger than environment variable "NUMEXPR_MAX_THREADS" (64)'
joined=marker('command','begin')+numeric_error+marker('command','phase','test')+numeric_error+marker('command','end','test')
for chunk in (1,13,4096):
    numeric=parse(joined,chunk=chunk)
    assert numeric['state']=='anomalous' and numeric['scanComplete'],numeric
    assert numeric['count']==2 and numeric['types']=={'LoggedError':2},numeric
    assert numeric['phases']=={'initialization':1,'test':1},numeric
    for item in numeric['exceptions']:
        assert joined.encode('utf8')[item['byteStart']:item['byteEnd']].decode('utf8')==numeric_error,item
assert parse(marker('command','begin')+'progress without newline'+marker('command','end'))['state']=='clear'
assert parse(marker('command','begin')+numeric_error+marker('other','end'))['scanComplete'] is False
for error_line in ('ERROR: failed to load checkpoint\n','[ERROR] invalid configuration\n'):
    assert parse(marker('command','begin')+error_line+marker('command','end'))['count']==1
callback='Exception ignored on calling ctypes callback function: <function probe at 0x1>\nTraceback (most recent call last):\n  File "threadpoolctl.py", line 1, in callback\n    get_config().split()\nAttributeError: \'NoneType\' object has no attribute \'split\'\n'
error=marker('command','begin')+marker('command','phase','train')+callback+'epoch 300/300\n'+marker('command','phase','test')+'test succeeded; acc=0\n'+marker('command','end','test')
value=parse(error,chunk=1)
assert value['state']=='anomalous' and value['scanComplete'] and value['count']==1
assert value['types']=={'AttributeError':1} and value['phases']=={'train':1}
event=value['exceptions'][0]
assert event['complete'] and callback.strip() in event['summary']
assert error.encode('utf8')[event['byteStart']:event['byteEnd']].decode('utf8').startswith('Exception ignored')
ignored='Exception ignored in: <function destructor>\nTraceback (most recent call last):\n  File "a.py", line 2\nRuntimeError: destructor failure\n'
assert parse(marker('command','begin')+ignored+marker('command','end'))['types']=={'RuntimeError':1}
ordinary='Traceback (most recent call last):\n  File "a.py", line 3\nValueError: failed input\n'
assert parse(marker('command','begin')+ordinary+marker('command','end'))['count']==1
child='subprocess.CalledProcessError: Command child returned non-zero exit status 2.\n'
assert parse(marker('command','begin')+child+marker('command','end'))['count']==1
assert parse(marker('old','begin')+callback+marker('old','end')+normal)['count']==0
assert parse(marker('command','begin')+callback+callback+marker('command','end'))['count']==2
many=parse(marker('command','begin')+callback*105+marker('command','end'))
assert many['count']==105 and len(many['exceptions'])==100 and many['truncatedExceptions']==5
assert parse(marker('command','begin')+'\x1b[31m'+ordinary+'\x1b[0m\n'+marker('command','end'))['types']=={'ValueError':1}
assert parse(callback)['state']=='unverified'
assert parse(marker('command','begin')+'ok\n')['state']=='scanning'
root=tempfile.mkdtemp(prefix='simpleex-log-scan-')
file=pathlib.Path(root,'raw.log')
file.write_text(marker('command','begin')+callback+('epoch 300/300\n'*400000)+marker('command','end'),encoding='utf8')
ns['task_safe_path']=lambda root,relative:str(pathlib.Path(root,relative))
job={'commandId':'command'}
# Make the elapsed-time slice deterministic even on fast local storage.
import itertools
from unittest.mock import patch
reader = ns['task_log_diagnostics']
clock = itertools.count(0, 2)
def sliced_reader(*args, **kwargs):
    with patch('time.monotonic', side_effect=lambda: next(clock)):
        return reader(*args, **kwargs)
ns['task_log_diagnostics'] = sliced_reader
first=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
assert first['count']==1 and not first['scanComplete']
last=first
for _ in range(64):
    if last['scanComplete']:break
    previous=last['bytesRead']
    last=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
    assert 0 < last['bytesRead']-previous <= 256*1024
assert last['count']==1 and last['scanComplete']
again=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
assert again==last
# Rewriting the tail with unchanged inode/length invalidates a previously complete scan.
data=file.read_bytes();file.write_bytes(data.replace(b'AttributeError',b'AssertionError'))
changed=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
for _ in range(64):
    if changed['scanComplete']:break
    changed=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
assert changed['scanComplete']
assert changed['types']=={'AssertionError':1}
file.write_bytes(data)
ns.pop('TASK_LOG_DIAGNOSTIC_CACHE')
ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
last=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
ns.pop('TASK_LOG_DIAGNOSTIC_CACHE')
ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
reconnected=ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)
assert reconnected['count']==1 and reconnected['exceptions'][0]['id']==last['exceptions'][0]['id']
file.write_text(marker('new','begin')+'ok\n'+marker('new','end'),encoding='utf8')
assert ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)['state']=='unverified'
assert ns['task_log_diagnostics'](root,{'commandId':'new'},{'logPath':'raw.log'},True)['state']=='clear'
assert ns['task_log_diagnostics'](root,job,{'logPath':'missing.log'},True)['state']=='unverified'
file.write_text(callback,encoding='utf8')
assert ns['task_log_diagnostics'](root,job,{'logPath':'raw.log'},True)['state']=='unverified'
historical=ns['task_log_diagnostics'](root,{**job,'runtimeLogAnalysisId':'explicit'}, {'logPath':'raw.log'},True)
assert historical['count']==1 and historical['scanComplete']
file.write_text(marker('old','begin')+callback+marker('old','end')+normal,encoding='utf8')
isolated=ns['task_log_diagnostics'](root,{**job,'runtimeLogAnalysisId':'explicit-new-scan'}, {'logPath':'raw.log'},True)
assert isolated['state']=='clear' and isolated['count']==0
# A current terminal query can verify a legacy command's own original log without
# a manual authorization, including after Agent restart. Arbitrary paths cannot.
ns['worker_task_console_log']=lambda command: hashlib.sha256(command.encode('utf8')).hexdigest()+'.console.log'
legacy_path=ns['worker_task_console_log']('legacy')
legacy_file=pathlib.Path(root,legacy_path)
legacy_file.write_text('WARNING: normal warning\nfinished\n',encoding='utf8')
legacy_job={'commandId':'legacy'}
automatic=ns['task_log_diagnostics'](root,legacy_job,terminal=True)
assert automatic['state']=='clear' and automatic['scanComplete'],automatic
ns.pop('TASK_LOG_DIAGNOSTIC_CACHE')
ns.pop('TASK_LOG_ANALYSIS_AUTHORIZATIONS',None)
assert ns['task_log_diagnostics'](root,legacy_job,terminal=True)['state']=='clear'
legacy_file.write_text('[simple-experiment-runtime] python train.py\n'+callback+'epoch 300/300\n[simple-experiment-runtime] python test.py\ntest succeeded\n',encoding='utf8')
anomalous=ns['task_log_diagnostics'](root,legacy_job,terminal=True)
assert anomalous['count']==1 and anomalous['phases']=={'train':1} and anomalous['scanComplete'],anomalous
legacy_file.write_text(callback+('epoch 300/300\n'*400000),encoding='utf8')
partial=ns['task_log_diagnostics'](root,legacy_job,terminal=True)
assert partial['count']==1 and not partial['scanComplete']
complete=partial
for _ in range(64):
    if complete['scanComplete']:break
    complete=ns['task_log_diagnostics'](root,legacy_job,terminal=True)
assert complete['count']==1 and complete['scanComplete']
assert ns['task_log_diagnostics'](root,legacy_job,{'logPath':'raw.log'},True)['state']=='unverified'
assert ns['task_log_diagnostics'](root,{'commandId':'different'},terminal=True)['state']=='unverified'
assert ns['task_log_diagnostics'](root,{'commandId':''}, {'logPath':legacy_path},True)['state']=='unverified'
assert ns['task_log_diagnostics'](root,legacy_job,terminal=False)['scanComplete'] is False
legacy_file.write_text(marker('old','begin')+callback+marker('old','end'),encoding='utf8')
assert ns['task_log_diagnostics'](root,legacy_job,terminal=True)['state']=='unverified'
# The actual Agent observation must fail a terminal run without falsifying its
# exit code or discarding artifacts, using the same original log scanner.
lifecycle=ast.parse(pathlib.Path(sys.argv[2]).read_text(encoding='utf8'))
exec(compile(ast.Module(body=[n for n in lifecycle.body if isinstance(n,ast.FunctionDef) and n.name=='task_public_observation'],type_ignores=[]),'public-observation','exec'),ns)
ns['now_iso']=lambda:'2026-10-28T16:00:00Z'
ns['task_manifest_observation']=lambda root,job:dict(runId='legacy',status='completed',present=True,verified=True,identityMatches=True,artifactsComplete=True,exitCode=0)
legacy_file.write_text(marker('legacy','begin')+numeric_error+marker('legacy','end'),encoding='utf8')
row=dict(tmuxWindowId='@1',tmuxPane='%1',tmuxSession='fixture',gpuId='0',dead=True,exitCode=0,phase='running',logPath=legacy_path)
public=ns['task_public_observation'](root,dict(commandId='legacy',projectId='p',workerId='w'),row)
assert public['status']=='failed' and not public['successful'],public
assert public['exitCode']==0 and public['executionState']=='exited' and public['resultState']=='complete',public
assert public['runtimeDiagnostics']['count']==1 and public['runtimeDiagnostics']['scanComplete'],public
print(json.dumps({'ok':True,'scenarios':12,'originalLogsRetained':True}))
