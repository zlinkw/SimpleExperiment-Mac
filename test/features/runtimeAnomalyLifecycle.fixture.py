"""Isolated original logs and CPU children; extract functions, never import a runtime."""
import ast, hashlib, json, os, pathlib, re, shlex, subprocess, sys, tempfile, threading
from contextlib import contextmanager

agent=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf8'))
scheduler=ast.parse(pathlib.Path(sys.argv[2]).read_text(encoding='utf8'))
root=pathlib.Path(tempfile.mkdtemp(prefix='se-anomaly-cpu-')); values=[]
names={'task_safe_path','task_manifest_observation','task_public_observation','worker_task_console_log','task_collection_result','job_shell_environment_prefix'}
nodes=[n for n in agent.body if isinstance(n,ast.FunctionDef) and (n.name in names or n.name.startswith('task_log_'))]
ns=dict(os=os,json=json,re=re,hashlib=hashlib,threading=threading,now_iso=lambda:'2026-10-16T00:00:00Z')
ns['shlex']=shlex
ns['JOB_SHELL_ENV_FIELDS']=next(ast.literal_eval(n.value) for n in agent.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='TASK_SHELL_ENV_FIELDS' for t in n.targets))
exec(compile(ast.Module(body=nodes,type_ignores=[]),'selected-agent-functions','exec'),ns)
names={'run_command','formal_job_writer','native_job_result','native_file_stat','runtime_log_phase'}
selected=[n for n in scheduler.body if isinstance(n,ast.FunctionDef) and (n.name in names or n.name.startswith('task_log_'))]
imports='''from __future__ import annotations
import os,json,re,hashlib,threading,subprocess,sys
from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager
NATIVE_RUNTIME_LOG_STATE=None
simple_conda_wrapped_args=lambda args,env:args
formal_job_preflight=lambda job,identity,mode:{'completed':False}
formal_job_safe_path=lambda relative:Path(relative)
formal_job_file_hash=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
'''
child=root/'synthetic.py'
child.write_text('''import sys
if sys.argv[1] in ('callback','early','train-test'):
 print("Exception ignored on calling ctypes callback function: <function callback>")
 print('Traceback (most recent call last):')
 print('  File "synthetic.py", line 3, in callback')
 print("AttributeError: 'NoneType' object has no attribute 'split'")
if sys.argv[1]=='early':
 for i in range(10000):print('epoch progress',i)
if sys.argv[1]=='warning':
 print('WARNING: zero predicted classes')
 print('[simple-adapter] Prefer environment nvJitLink over system CUDA')
if sys.argv[1]=='failure':
 print('Traceback (most recent call last):')
 print('ValueError: synthetic failure')
 sys.exit(7)
print('completed 300/300; metric=0')
''',encoding='utf8')
for kind in ('normal','warning','callback','failure','early','train-test'):
 command='cpu-'+kind;out='work/'+kind;log=ns['worker_task_console_log'](command)
 (root/out).mkdir(parents=True);(root/log).parent.mkdir(parents=True,exist_ok=True)
 (root/out/'weight.pth').write_bytes(b'synthetic-weight')
 (root/out/'metric.csv').write_text('metric\n0\n',encoding='utf8')
 program=imports+'\n'+ast.unparse(ast.Module(body=selected,type_ignores=[]))+'\n'
 program+='''
command,output,log,kind=sys.argv[1:]
assert os.environ['SIMPLE_EXPERIMENT_TASK_LIFECYCLE']=='2'
assert os.environ['SIMPLE_EXPERIMENT_RUNTIME_LOG_PATH']==log
job=SimpleNamespace(output_dir=output,result_csv=output+'/metric.csv',index=0,case='synthetic',seed=42,template_values={'plan_file':'experiments/plans/cpu.yaml'})
task_log_marker(command,'begin','prepare')
with formal_job_writer(job,{'commandId':command},'train_test'):
 runtime_log_phase('train')
 try:run_command([sys.executable,'synthetic.py',kind],os.environ.copy())
 except subprocess.CalledProcessError as exc:raise SystemExit(exc.returncode)
 runtime_log_phase('test')
 run_command([sys.executable,'synthetic.py','normal'],os.environ.copy())
'''
 runner=root/(kind+'-runner.py');runner.write_text(program,encoding='utf8')
 prefix=ns['job_shell_environment_prefix']({'SIMPLE_EXPERIMENT_TASK_LIFECYCLE':'2','SIMPLE_EXPERIMENT_RUNTIME_LOG_PATH':log})
 assert 'SIMPLE_EXPERIMENT_RUNTIME_LOG_PATH='+log in shlex.split(prefix)
 with (root/log).open('wb') as raw:
  proc=subprocess.run(shlex.split(prefix)+[sys.executable,'-B','-X','utf8',str(runner),command,out,log,kind],cwd=root,stdout=raw,stderr=subprocess.STDOUT,timeout=3)
 assert proc.returncode==(7 if kind=='failure' else 0)
 job=dict(commandId=command,projectId='project',workerId='worker',outputDir=out,collectionResultCsv=out+'/metric.csv',mode='train_test',experimentIndex=0,case='synthetic',seed=42)
 row=dict(tmuxWindowId='@1',tmuxPane='%1',tmuxSession='test',gpuId='0',dead=True,exitCode=proc.returncode,phase='running',logPath=log)
 public=ns['task_public_observation'](str(root),job,row)
 assert public['resultState']=='complete' and public['observation']['result']['artifactsComplete']
 collected=ns['task_collection_result'](str(root),dict(index=0,case='synthetic',seed=42,output_dir=out,result_csv=out+'/metric.csv',mode='train_test',planFile='experiments/plans/cpu.yaml'))
 assert collected['completed'] and collected['exitCode']==proc.returncode and len(collected['files'])==2
 anomaly=kind in ('callback','failure','early','train-test')
 assert public['runtimeDiagnostics']['count']==(1 if anomaly else 0),(kind,public)
 if anomaly:assert public['runtimeDiagnostics']['phases']=={'train':1}
 manifest=json.loads((root/out/'artifact_manifest.json').read_text(encoding='utf8'))['simpleExperiment']
 assert manifest['runtimeDiagnostics']['count']==(1 if anomaly else 0)
 assert (root/out/'metric.csv').read_text(encoding='utf8')=='metric\n0\n'
 # Task diagnostics still handle pre-upgrade logs. Collection uses artifacts only.
 # Keep original command-specific logs, but remove only fixture framing/summary.
 raw=(root/log).read_text(encoding='utf8')
 (root/log).write_text('\n'.join(line for line in raw.splitlines() if not line.startswith('[simple-experiment-runtime-log] '))+'\n',encoding='utf8')
 document=json.loads((root/out/'artifact_manifest.json').read_text(encoding='utf8'))
 document['simpleExperiment'].pop('runtimeDiagnostics',None)
 document['simpleExperiment'].pop('exitCode',None)
 (root/out/'artifact_manifest.json').write_text(json.dumps(document),encoding='utf8')
 ns.pop('TASK_LOG_DIAGNOSTIC_CACHE',None)
 ns.pop('TASK_LOG_ANALYSIS_AUTHORIZATIONS',None)
 legacy=ns['task_public_observation'](str(root),job,row)
 assert legacy['runtimeDiagnostics']['scanComplete'] and legacy['runtimeDiagnostics']['count']==(1 if anomaly else 0),(kind,legacy)
 assert legacy['completionState']==('review_required' if anomaly else 'verified')
 legacy_collection=ns['task_collection_result'](str(root),dict(index=0,case='synthetic',seed=42,output_dir=out,result_csv=out+'/metric.csv',mode='train_test',planFile='experiments/plans/cpu.yaml'))
 assert legacy_collection['completed'] and 'runtimeDiagnostics' not in legacy_collection
 assert public['status']==('failed' if anomaly else 'completed'),(kind,public)
 values.append(dict(observation=public['observation'],expectedStatus='failed' if anomaly else 'completed',expectedCompletion='review_required' if anomaly else 'verified',exitCode=proc.returncode))
print(json.dumps(values))
