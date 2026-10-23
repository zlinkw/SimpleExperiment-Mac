const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {CLUSTER_SCHEDULER_RUNTIME}=require('../dist/clusterSchedulerRuntime');
test('Worker runtime ships formal dispatch checks and explicitly retires the global Hub dispatcher',()=>{
  for(const marker of ['def probe_idle_gpus','def launch_experiment','FORMAL_JOB_DECLARATION_CHANGED','formal_source_fingerprint','GLOBAL_SCHEDULER_REMOVED: use the Worker native tmux task queue'])assert.ok(CLUSTER_SCHEDULER_RUNTIME.includes(marker),marker);
  const mainAt=CLUSTER_SCHEDULER_RUNTIME.indexOf('def main()');assert.ok(mainAt>0);
  assert.doesNotMatch(CLUSTER_SCHEDULER_RUNTIME.slice(mainAt),/while queue:/);
});
test('the extracted CLI entry rejects global dispatch with pending input and only routes explicit job execution',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-entry-routing-')),file=path.join(directory,'probe.py');
  const runtime=path.resolve(__dirname,'../dist/runtime/cluster_scheduler.py');
  fs.writeFileSync(file,`
import ast,argparse,os,pathlib,sys
source=pathlib.Path(${JSON.stringify(runtime)}).read_text(encoding="utf-8")
main=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=="main")
called=[]
namespace={"argparse":argparse,"os":os,"normalize_default_result_csv_dir":lambda value:value,"run_job_mode":lambda args:called.append((args.plan,args.only_index))}
exec(compile(ast.Module(body=[main],type_ignores=[]),"isolated-main","exec"),namespace)
sys.argv=["fixture","--plan","missing-pending-plan.yaml","--workers-json","missing-workers.json"]
try:
    namespace["main"]()
except SystemExit as exc:
    assert "GLOBAL_SCHEDULER_REMOVED" in str(exc),str(exc)
else:
    raise AssertionError("pending global queue silently completed")
assert called==[]
sys.argv=["fixture","--plan","fixture.yaml","--run-job","--only-index","0"]
namespace["main"]()
assert called==[("fixture.yaml",0)],called
print("ok")
`);
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',file],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
});
