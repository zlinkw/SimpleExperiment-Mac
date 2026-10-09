const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function run(mode) {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(),'agent-subprocess-progress-'));
  const script = path.join(evidence,'probe.py');
  const runtime = path.resolve(__dirname,'../../dist/runtime/cluster_agent.py');
  fs.writeFileSync(script, `import ast, io, json, os, subprocess, threading, signal, collections, sys
tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
names={'subprocess_inactivity_run','subprocess_file_io'}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
mode=sys.argv[2]
class Clock:
 def __init__(self): self.now=0
 def monotonic(self): return self.now
 def sleep(self,_): self.now+=31
clock=Clock()
class Thread:
 def __init__(self,target,args=(),**kwargs): self.target=target; self.args=args
 def start(self): self.target(*self.args)
 def join(self,timeout=None): pass
class Process:
 pid=1234
 def __init__(self):
  self.polls=0; self.returncode=0; self.stopped=False
  self.stdout=io.StringIO('x'*(4*1024*1024+1) if mode=='oversized' else '')
  self.stdin=io.StringIO()
  self.stderr=io.StringIO(('SIMPLE_PROGRESS {"phase":"hashing","processedBytes":1}\\n'*100 if mode=='heartbeat' else 'SIMPLE_PROGRESS []\\nSIMPLE_PROGRESS {"phase":"bad","processedBytes":-1}\\n' if mode=='malformed' else ('x'*8000+'\\n')*500+'important-final-tail\\n' if mode=='stderr-flood' else 'merge checkpoint context\\n'))
 def poll(self):
  self.polls+=1
  if mode=='cancel-mid' and self.polls==3: context.entry['cancel'].set()
  return None if self.polls<=8 else self.returncode
 def terminate(self): self.stopped=True
 def kill(self): self.stopped=True
 def wait(self,timeout=None): return self.returncode
process=Process(); events=[]; samples=[]
context=threading.local()
if mode in ('cancel','cancel-mid'):
 context.entry={'cancel':threading.Event(),'processes':set(),'root':'/project','action':'rebuild-distributed-results','operationId':'owned','opId':'owned','payload':{}}
 if mode=='cancel': context.entry['cancel'].set()
def sample(_):
 samples.append(clock.now)
 if mode=='unobservable': return None
 return (0,0) if mode=='heartbeat' else (100 if mode in ('stalled','stdin-only') else len(samples)*100,0)
ns={'os':type('OS',(),{'path':os.path})(), 'json':json,'time':clock, 'signal':signal,'deque':collections.deque,'io':io,
 'subprocess':type('SP',(),{'Popen':lambda *a,**kw:process,'PIPE':subprocess.PIPE,'DEVNULL':subprocess.DEVNULL,'TimeoutExpired':subprocess.TimeoutExpired,'CompletedProcess':subprocess.CompletedProcess})(),
 'threading':type('TH',(),{'Thread':Thread,'Lock':threading.Lock})(),
 'INACTIVITY_ACTION_CONTEXT':context,'INACTIVITY_ACTIONS_LOCK':threading.Lock(),
 'progress_action':lambda *a,**kw:events.append(a),'now_iso':lambda:'now','redact_text':lambda s:s}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'production-helpers','exec'),ns)
ns['subprocess_file_io']=sample
try:
 result=ns['subprocess_inactivity_run'](['python','-m','example.merge'],file_step=mode!='control',input='m'*100 if mode=='stdin-only' else None)
 outcome={'status':'completed','stopped':process.stopped,'elapsed':clock.now,'samples':len(samples),'stderrLength':len(result.stderr),'stderrTail':result.stderr[-50:]}
except RuntimeError as exc:
 outcome={'status':'failed','stopped':process.stopped,'error':str(exc),'elapsed':clock.now,'samples':len(samples),'tracked':len(context.entry['processes']) if hasattr(context,'entry') else 0}
print(json.dumps(outcome))
`, 'utf8');
  const result=spawnSync('python',['-B','-X','utf8',script,runtime,mode],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('legacy result rebuild continues beyond 120 seconds while silently reading checkpoints',()=>{
  const result=run('reading');
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.stopped,false); assert.ok(result.elapsed>120); assert.ok(result.samples>0);
});

test('a stopped read counter and repeated stdout telemetry still time out',()=>{
  for(const mode of ['stalled','heartbeat']) {
    const result=run(mode);
    assert.equal(result.status,'failed'); assert.equal(result.stopped,true);
    assert.match(result.error,/无真实进展/);
    assert.ok(result.elapsed>=120 && result.elapsed<=155);
  }
});

test('control requests keep their 30 second deadline and never use file I/O as keepalive',()=>{
  const result=run('control');
  assert.equal(result.status,'failed'); assert.equal(result.stopped,true);
  assert.equal(result.samples,0); assert.equal(result.elapsed,31);
});

test('explicit cancellation still wins over ongoing file reads',()=>{
  const result=run('cancel');
  assert.equal(result.status,'failed'); assert.match(result.error,/操作已取消/);
  assert.equal(result.samples,0);
  const mid=run('cancel-mid');
  assert.equal(mid.status,'failed'); assert.match(mid.error,/操作已取消/);
  assert.equal(mid.stopped,true); assert.ok(mid.samples>0); assert.equal(mid.elapsed,62); assert.equal(mid.tracked,0);
});

test('reading the input manifest does not masquerade as ongoing file work',()=>{
  const result=run('stdin-only');
  assert.equal(result.status,'failed'); assert.equal(result.stopped,true);
  assert.ok(result.elapsed>=120 && result.elapsed<=155);
  assert.match(result.error,/读取 0 字节/);
});

test('timeout identifies the merge step, phase and bounded stderr context',()=>{
  const result=run('stalled');
  assert.match(result.error,/example.merge/); assert.match(result.error,/local-file-io/);
  assert.match(result.error,/merge checkpoint context/); assert.ok(result.error.length<3000);
  const denied=run('unobservable');
  assert.equal(denied.status,'failed'); assert.match(denied.error,/文件 I\/O 不可观测/);
});

test('malformed progress cannot crash the reader while genuine checkpoint work continues',()=>{
  const result=run('malformed');
  assert.equal(result.status,'completed'); assert.equal(result.stopped,false);
});

test('verbose stderr remains bounded and oversized stdout cannot become a truncated result',()=>{
  const result=run('stderr-flood');
  assert.equal(result.status,'completed'); assert.ok(result.stderrLength<=32768);
  assert.match(result.stderrTail,/important-final-tail/);
  const large=run('oversized');
  assert.equal(large.status,'failed'); assert.match(large.error,/标准输出超过 4 MiB/);
});

test('Linux I/O sampler ignores pipe writes and rejects unavailable or malformed counters',()=>{
  const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'agent-io-counter-'));
  const script=path.join(evidence,'probe.py');
  fs.writeFileSync(script,`import ast,os,json,sys
tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='subprocess_file_io')
ns={'os':os}; exec(compile(ast.Module(body=[node],type_ignores=[]),'owned-io','exec'),ns)
root=sys.argv[2]; os.makedirs(os.path.join(root,'1234'),exist_ok=True)
class Process: pid=1234
file=os.path.join(root,'1234','io')
def sample(text):
 with open(file,'w',encoding='ascii') as out: out.write(text)
 return ns['subprocess_file_io'](Process(),root)
assert sample('rchar: 512\\nwchar: 99999999\\nread_bytes: 128\\nwrite_bytes: 64\\n')==(512,64)
assert sample('rchar: 512\\nwchar: 888888888\\nwrite_bytes: 64\\n')==(512,64)
for raw in ('rchar: -1\\nwrite_bytes: 0','rchar: bad\\nwrite_bytes: 0','rchar: 1\\nrchar: 2\\nwrite_bytes: 0','rchar: 1','x'*5000):
 assert sample(raw) is None
assert ns['subprocess_file_io'](Process(),os.path.join(root,'missing')) is None
print('ok')
`,'utf8');
  const result=spawnSync('python',['-B','-X','utf8',script,path.resolve(__dirname,'../../dist/runtime/cluster_agent.py'),evidence],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),'ok');
});
