const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('oversized terminal journals retain bounded identity and completion receipts, while telemetry remains a gap', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../dist/runtime/cluster_agent.py'), 'utf8');
  const script = path.join(os.tmpdir(), `agent-terminal-receipt-${process.pid}.py`);
  fs.writeFileSync(script, `import ast, json, threading, io
tree=ast.parse(${JSON.stringify(source)})
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'append_event','compact_terminal_event'}]
lines=[]
class Journal(io.StringIO):
 def __exit__(self,*args): lines.append(self.getvalue()); self.close()
ns={'json':json,'os':type('OS',(),{'makedirs':lambda *args,**kwargs:None})(),
 'EVENT_APPEND_LOCK':threading.RLock(),'SCHEMA_VERSION':1,'MAX_AGENT_EVENT_RECORD_BYTES':192*1024,
 'prune_runtime_memory_state':lambda:None,'agent_dir':lambda root:root,'read_seq':lambda root:0,
 'write_seq':lambda *args:None,'path_for':lambda *args:'journal','now_iso':lambda:'2026-10-06',
 'open':lambda *args,**kwargs:Journal(),'compact_journal':lambda root:None,
 'prune_agent_state':lambda root:None,'maybe_auto_run_completion_pipeline':lambda *args:None}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'functions','exec'),ns)
for status in ['completed','failed','cancelled']:
 event_type='operation_'+status
 out=ns['append_event']('/project',{'type':event_type,'operationId':'fresh-id','payload':{
  'status':status,'action':'rebuild-distributed-results','opId':'fresh-id','message':'回执',
  'outputPaths':['results/table.csv'],'jobCount':6,'runId':'run-b','rows':['x'*684929]}})
 assert out['type']==event_type and out['operationId']=='fresh-id'
 assert out['payload']['status']==status and out['payload']['outputPaths']==['results/table.csv']
 assert out['payload']['jobCount']==6 and out['payload']['runId']=='run-b' and 'rows' not in out['payload']
 assert len(lines[-1].encode('utf-8')) < 192*1024
out=ns['append_event']('/project',{'type':'operation_completed','operationId':'fresh-id','payload':{
 'status':'completed','outputPaths':['a']*65,'rows':['x'*684929]}})
assert out['type']=='operation_failed' and out['payload']['status']=='failed'
out=ns['append_event']('/project',{'type':'operation_progress','operationId':'id','payload':{'rows':['x'*684929]}})
assert out['type']=='diagnostics_updated' and out['payload']['code']=='journal_gap'
print('ok')
`, 'utf8');
  const result = spawnSync('python', ['-X', 'utf8', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
});

test('tracked async actions deduplicate and suppress cancelled terminal/progress events',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../dist/runtime/cluster_agent.py'),'utf8');
  const script=path.join(os.tmpdir(),`agent-inactivity-${process.pid}.py`);
  fs.writeFileSync(script,`import ast, json, threading, os
source=${JSON.stringify(source)}
tree=ast.parse(source)
names={'start_inactivity_action','cancel_inactivity_action','terminal_action','progress_action'}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
events=[]; threads=[]
class Thread:
 def __init__(self,target,**kwargs): self.target=target
 def start(self): threads.append(self)
ns={'threading':type('T',(),{'Thread':Thread,'Lock':threading.Lock,'Event':threading.Event})(), 'os':os, 'SCHEMA_VERSION':1,
'INACTIVITY_ACTIONS':{},'INACTIVITY_ACTIONS_LOCK':threading.Lock(),'INACTIVITY_ACTION_CONTEXT':threading.local(),
'append_event':lambda root,event:events.append(event),'action_operation_fields':lambda p:p,
'action_plan_file':lambda p:p.get('planFile',''),'action_event_fields':lambda extra,request:extra or {}}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'functions','exec'),ns)
a=ns['start_inactivity_action']('/project','validate-plan',{'planFile':'a.yaml'},'id','id')
b=ns['start_inactivity_action']('/project','validate-plan',{'planFile':'a.yaml'},'id','id')
assert a['status']==b['status']=='accepted' and len(threads)==1
assert not ns['cancel_inactivity_action']('/project','id','other.yaml')
assert ns['cancel_inactivity_action']('/project','id','a.yaml')
entry=ns['INACTIVITY_ACTIONS'][(os.path.abspath('/project'),'id')]
ns['INACTIVITY_ACTION_CONTEXT'].entry=entry
count=len(events)
ns['progress_action']('/project','validate-plan','id','id','running','late')
assert len(events)==count
result=ns['terminal_action']('/project','validate-plan','id','id','completed','late')
assert result['status']=='cancelled' and events[-1]['type']=='operation_cancelled'
print('ok')
`,'utf8');
  const result=spawnSync('python',[script],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'ok');
});
