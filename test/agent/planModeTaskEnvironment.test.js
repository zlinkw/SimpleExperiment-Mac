const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Plan mode uses selected task environment when helper YAML is absent, binds revision and reports startup failure to exact pane',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'se-plan-mode-')),script=path.join(dir,'check.py');
 const root=path.resolve(__dirname,'../..').replaceAll('\\','/');
 const body=String.raw`
import hashlib, json, os, pathlib, sys, types
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(root+'/test/_helpers')})
from extractRuntimeFunctions import extract_runtime_functions
root = Path(${JSON.stringify(dir.replaceAll('\\','/'))})
plan = root / 'plan.yaml'
plan.write_text('{"mode":"train"}', encoding='utf-8')
raw = plan.read_bytes()
revision = hashlib.sha256(raw).hexdigest()
scheduler = dict(Path=Path, hashlib=hashlib, json=json, sys=sys, yaml=types.SimpleNamespace(safe_load=json.load))
extract_runtime_functions(${JSON.stringify(root+'/dist/runtime/cluster_scheduler.py')}, ['load_yaml_file','load_plan','plan_execution_mode','plan_execution_mode_report'], scheduler)
queries=[]
def query(args, **kwargs):
    queries.append((args, kwargs))
    assert '--plan-execution-mode-json' in args and '--plan-revision' in args
    assert '--validate-plan' not in args and '--run-job' not in args
    assert kwargs['env']['selected'] == 'research'
    try: report=scheduler['plan_execution_mode_report'](plan, revision)
    except Exception as exc: return types.SimpleNamespace(returncode=1, stderr=str(exc), stdout='')
    return types.SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(report))
agent=dict(pathlib=pathlib,hashlib=hashlib,json=json,
    safe_project_path=lambda root,p: str(Path(root)/p), durable_plan_value=lambda c,k:c.get(k),
    scalar_scheduler_module=lambda:types.SimpleNamespace(yaml=None), formal_job_command_env=lambda c:{'selected':c['condaEnv']},
    simple_runtime_python=lambda env:'selected-python', cluster_scheduler_path=lambda root:'scheduler.py',
    simple_conda_wrapped_args=lambda args,env:args, subprocess_inactivity_run=query)
extract_runtime_functions(${JSON.stringify(root+'/dist/runtime/cluster_agent.py')}, ['verified_durable_execution_mode'],agent)
command={'planFile':'plan.yaml','planRevision':revision,'executionMode':'train','mode':'train','condaEnv':'research'}
verify=lambda c:agent['verified_durable_execution_mode'](str(root),c)
assert verify(command)=='train' and len(queries)==1
def rejected(call, text):
    try: call()
    except Exception as exc: assert text in str(exc), str(exc)
    else: raise AssertionError('expected rejection: '+text)
rejected(lambda:verify({**command,'executionMode':'test'}),'Validated execution mode disagrees')
before=len(queries)
rejected(lambda:verify({**command,'planRevision':'wrong'}),'Original Plan revision unavailable')
assert len(queries)==before
scheduler['yaml']=None
rejected(lambda:verify(command),'PLAN_YAML_UNAVAILABLE')
scheduler['yaml']=types.SimpleNamespace(safe_load=json.load)
agent['subprocess_inactivity_run']=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'executionMode':'train','planRevision':'wrong'}))
rejected(lambda:verify(command),'revision disagrees')
def mutated(*args, **kwargs):
    report=scheduler['plan_execution_mode_report'](plan,revision)
    plan.write_text('{"mode":"test"}',encoding='utf-8')
    return types.SimpleNamespace(returncode=0,stdout=json.dumps(report))
agent['subprocess_inactivity_run']=mutated
rejected(lambda:verify(command),'Plan changed during')
plan.write_bytes(raw)
for foreign in (False, True):
    writes=[]; reads=[]
    job={'root':os.path.realpath(root),'workerId':'w','pane':'%1','commandId':'original','options':{}}
    def read_job(pane):
        reads.append(pane)
        return {**job,'commandId':'foreign' if foreign and len(reads)>1 else 'original'}
    def option(pane,key,value=None):
        if value is not None: writes.append((pane,key,value)); return value
        return 'bound' if key=='job' else 'admitted' if key=='phase' else '0'
    def execute(*a): raise RuntimeError('PLAN_YAML_UNAVAILABLE')
    native={'os':os,'time':__import__('time'),'task_option':option,'task_read_job':read_job,'execute_worker_command':execute,'cluster_scheduler_path':lambda root:'scheduler.py'}
    extract_runtime_functions(${JSON.stringify(root+'/dist/runtime/cluster_agent.py')},['task_runner'],native)
    os.environ['TMUX_PANE']='%1'
    rejected(lambda:native['task_runner'](str(root),'w'),'PLAN_YAML_UNAVAILABLE')
    failures=[row for row in writes if row[1] in ('error',) or row[1]=='phase' and row[2]=='failed']
    assert len(failures)==(0 if foreign else 2), failures
print('selected-task-parser, revision/mode checks, missing YAML and exact-pane failure passed')
`;
 fs.writeFileSync(script,body,'utf8');
 const r=spawnSync(process.platform==='win32'?'python':'python3',['-X','utf8',script],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(r.status,0,(r.stdout||'')+(r.stderr||''));
});
