const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');

require('../_helpers/registerTsRequire');

const ledger=require('../../src/features/PlanIsolatedBatchLedger.ts');

const {runSelectedPlans}=require('../../src/extension/SelectedPlanBatchHost.ts');

const Q=require('../../src/features/DistributedPlanQueue.ts');


// 契约 batch-ledger-contract-v1 + r17 复审裁决：
// 初始集合不可扩（合并/迟到回执都不行）；void/dispatched 终局不回退不复活；同一 completed 隔离 operation 的
// 目标集合与 revision/codeFingerprint 首写冻结（相同幂等、冲突拒收保留）；启动证明只认「已登记轮询的原生 running /
// 队列粘性原生证明」，终态与取消标记不反推启动；逐 job 证明先证先存持久保留（不要求同时新鲜）；未来时间戳拒绝；
// 跨进程 CAS 锁（活 owner 永不窃取、失主 fencing、写入前 token 复核）。真实 producer 链用真 enqueuePlan/
// 真 mergeDurableWorkerSnapshots/真 legacy 方法体（同 requeue 套件提取法）驱动；互斥用两个真实 PID 的 IPC 夹具。
// 不连服务器、不删真实文件。

const ts=require('typescript');

const tmpFile=name=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'se-iso-ledger-')),name);

const replacementState=token=>({flow:'isolate',done:true,completed:[token],
  previews:[{index:0,preview:{token,action:'isolate',rows:[
    {disposition:'isolate',relativePath:'work/a0',destination:'clean_dir/20261022/work/a0',absolutePath:'/srv/proj/work/a0',archiveBatch:'20261022',node:{id:'w1',host:'h1.example'}},
    {disposition:'isolate',relativePath:'work/no-dest',absolutePath:'/srv/proj/work/no-dest',node:{id:'w1',host:'h1.example'}}]}}]});

function extractMethodBody(source,name){
  const at=source.indexOf(name); if(at<0) throw Error('METHOD_NOT_FOUND '+name);
  let i=source.indexOf('{',at),depth=0,end=-1;
  for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;else if(source[j]==='}'){depth-=1;if(!depth){end=j;break;}}}
  if(end<0) throw Error('METHOD_UNBALANCED '+name);
  return source.slice(i+1,end);
}

const legacySource=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');

const transpile=body=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;


const seed=async({file,jobs=[{jobIndex:0,expectedCommandId:'new-0'}],canonical='cp-1',attach=true})=>{
  await ledger.freezeBatchScope(file,{batchId:'b-1',projectRoot:'/proj',canonicalProjectId:canonical},[{planFile:'plans/a.yaml',submissionOperationId:'op-a'}]);
  if(attach) await ledger.attachIsolatedCleanup(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',revision:'r',codeFingerprint:'f',runReplacement:replacementState('tok-b')});
  await ledger.markPlanTerminal(file,{batchId:'b-1'},{submissionOperationId:'op-a',planFile:'plans/a.yaml',status:'committed',
    identity:{queuePlanId:'card',jobs}});
  return file;
};

const observed=(when,extra={})=>({queuePlanId:'card',projectId:'cp-1',jobIndex:0,commandId:'new-0',workerId:'worker',
  status:'running',lastObservedAt:new Date(when).toISOString(),statusQueryError:'',...extra});


// r28-U1（主控批准）：完整 drain 并保留子进程 stdio；done 之前任何 IPC error / 退出 / 传输故障即时拒绝全部
// pending wait 并附真实诊断（旧版吞 error、Socket.toString 打印 [object Object]、伪装 3000ms IPC timeout 的缺陷即首因伪装层）。
// done 之后的收尾 send/EPIPE 属清理竞态，不影响已完成结果。3000ms 既有预算原样保留，未延长。
function spawnChild(distFile,file,mode,eventsFile){
  const p=fork(path.resolve(__dirname,'planIsolatedBatchLedger.lockChild.cjs'),[distFile,file,mode,eventsFile||''],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  const io={stdout:'',stderr:''};
  p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
  p.stdout.on('data',c=>{io.stdout+=c;});p.stderr.on('data',c=>{io.stderr+=c;});
  const events=[];const waiters=new Map();let done=false;let failure=null;
  const diag=()=>'events='+JSON.stringify(events.map(m=>m.event))+' exitCode='+String(p.exitCode)+' signal='+String(p.signalCode)+' stdout='+JSON.stringify(io.stdout)+' stderr='+JSON.stringify(io.stderr);
  const failAll=err=>{if(!failure)failure=err;for(const [,arr] of waiters)for(const w of arr){clearTimeout(w.timer);w.reject(Error(err.message+' | '+diag()));}waiters.clear();};
  p.on('message',m=>{events.push(m);if(m.event==='done')done=true;
    if(m.event==='error')failAll(Error('child IPC error: '+String(m.message||'')));
    const arr=waiters.get(m.event)||[];waiters.delete(m.event);for(const w of arr){clearTimeout(w.timer);w.resolve(m);}});
  p.on('exit',(code,sig)=>{if(!done)failAll(Error('child exited before done code='+String(code)+' signal='+String(sig)));});
  p.on('error',e=>{if(!done)failAll(Error('child transport error: '+String((e&&e.message)||e)));}); // done 后清理 EPIPE 不推翻结果；done 前即时上报
  const wait=event=>new Promise((resolve,reject)=>{
    const hit=events.find(m=>m.event===event);if(hit)return resolve(hit);
    if(failure)return reject(Error(failure.message+' | '+diag()));
    const w={};w.resolve=resolve;w.reject=reject;
    w.timer=setTimeout(()=>{const arr=waiters.get(event)||[];waiters.set(event,arr.filter(x=>x!==w));reject(Error('IPC timeout '+event+' | '+diag()));},3000);
    waiters.set(event,[...(waiters.get(event)||[]),w]);});
  return {p,events,wait};
}


function batchFixture({ledgerFile,statuses={}}={}){
  const context={root:'/proj'};
  const host={client:{},localOperations:{},localPlanMetadata:{plans:['a','b'].map(n=>({planFile:'plans/'+n+'.yaml'}))},
    captureProjectContext:()=>context,projectContextIsCurrent:()=>true,refreshLocalPlanMetadataForAction:async()=>{},
    distributedPlanEligible:()=>true,localDistributedCodeFingerprint:async()=>'fp',
    workerActionTargets:()=>[{id:'w1',host:'h1.example',user:'u',port:22,project_dir:'/srv/proj'}],
    planSubmissionOperationId:m=>'plan-submit-'+m.clientActionId,
    isolatedReplacementLedgerFileLocal:()=>ledgerFile||'',
    planIsolatedReplacementsLocal:new Map(),
    runActionCommand:async(command,message)=>{
      const operationId=host.planSubmissionOperationId(message);
      const status=statuses[message.planFile]||'succeeded';
      if(status==='throw'){host.localOperations[operationId]={status:'failed',message:'隔离前校验失败'};throw Error('隔离前校验失败');}
      // 与 legacy 生产同一调用形态（真实账本模块、真实批次身份；账本失败被吞=审核入口失败关闭）。
      const isolated=!['plain','unknown'].includes(status);
      if(isolated||status==='unknown') host.planIsolatedReplacementsLocal.set(operationId,{planFile:message.planFile,count:1});
      try{
        if(isolated) await ledger.attachIsolatedCleanup(ledgerFile,host.currentIsolatedBatchLocal,{submissionOperationId:operationId,planFile:message.planFile,
          revision:'rev-'+message.planFile,codeFingerprint:'fp',runReplacement:replacementState('tok-'+operationId)});
        if(status!=='unknown') await ledger.commitIsolatedEnqueueLocalShim(ledgerFile,host.currentIsolatedBatchLocal,operationId,message.planFile,'plan-'+message.planFile,
          [{index:0,commandId:'cmd-'+operationId}]);
      }catch{}
      host.localOperations[operationId]={status,message:status==='unknown'?'结果未核实':'queue saved'};
    }};
  return host;
}

// 与 legacy.commitIsolatedEnqueueLocal 同形状的 shim（本夹具无法装载整类；legacy 侧形状由源码钉+上面的真实方法体测试覆盖）。
ledger.commitIsolatedEnqueueLocalShim=async(file,batchInfo,submissionOperationId,planFile,cardId,jobs)=>
  ledger.markPlanTerminal(file,batchInfo,{submissionOperationId,planFile,status:'committed',
    identity:{queuePlanId:cardId,jobs:jobs.map(row=>({jobIndex:Number(row.index),expectedCommandId:String(row.commandId||row.nextCommandId||'')}))}});

async function runBatch(host,planFiles=['plans/a.yaml','plans/b.yaml']){return runSelectedPlans(host,{planFiles});}
module.exports={test,assert,fs,os,path,fork,ledger,runSelectedPlans,Q,ts,tmpFile,replacementState,extractMethodBody,legacySource,transpile,seed,observed,spawnChild,batchFixture,runBatch};
