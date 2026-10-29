const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path'),assert=require('node:assert/strict');
module.exports=async function launchMessages(memory,workerOverride={}){
 const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'src/extension/legacy.ts'),'utf8');
 const ast=ts.createSourceFile('host.ts',source,ts.ScriptTarget.Latest,true),cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider');
 const send=cls.members.find(n=>n.name?.getText(ast)==='sendDistributedJob').getText(ast);
 const proof=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='durableCodeProofRequestFields').getText(ast);
 const Provider=vm.runInNewContext(ts.transpileModule(proof+';class Provider{'+send+'};Provider;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  workspaceRoot:()=>root,PlanExecutionMode:require('../../dist/features/PlanExecutionMode'),DistributedSchedulingPolicy:require('../../dist/features/DistributedSchedulingPolicy'),
  GpuQuotaScheduling:require('../../dist/features/GpuQuotaScheduling'),GpuMemoryScheduling:require('../../dist/features/GpuMemoryScheduling'),PlanCodeScopeHost:require('../../dist/extension/PlanCodeScopeHost'),vscode:{workspace:{getConfiguration:()=>({get:()=>undefined})}},AgentTmuxPolicy_1:require('../../dist/tunnel/AgentTmuxPolicy')});
 const p=new Provider(),messages=[];Object.assign(p,{distributedQueueGeneration:0,distributedPlanStopEpoch:0,setupConfig:{sessionPrefix:'My-Tasks',remoteTmuxSessionPrefix:'obsolete'},
  // 块B发送守卫：夹具根不在统一登记域（登记表空）→ active:false，即既有单机发送路径。
  unifiedDomainState:()=>({active:false,blocked:""}),
  client:{postWorkerAction:async(_worker,action,body)=>messages.push({...JSON.parse(JSON.stringify(body)),action})},
  enabledWorkerConfigs:()=>[{id:'worker',maxConcurrentGpus:1,...workerOverride}],workerActionTargets:()=>[{id:'worker',condaEnv:'/fixture/env'}],schedulerSettings:()=>memory||{},
  lastWorkerProbes:{worker:{capabilities:{endpoints:{gpuQuotaScheduling:1,gpuCardQuotaScheduling:1,gpuCardLimitScheduling:1,gpuMemoryBudgetScheduling:1,gpuMemoryRatioScheduling:memory?1:undefined,declaredJobPaths:true,formalJobIdentityEnv:1,taskShellEnvironment:1,projectManagedValidation:1},actionEndpoints:{'register-code-sync-proof':true}}}},
  lastCodeSyncState:{workerVersions:{worker:{codeSyncProofId:'proof',manifestDigest:'b'.repeat(64),fingerprint:'b'.repeat(64)}}},
  lastWorkerTaskSnapshots:new Map([[root+'\0worker',{capabilities:{taskLifecycle:2,gpuMemoryRatioScheduling:memory?1:undefined}}]])});
 const plan={id:'workflow',projectId:'project',planFile:'experiments/plans/中文 plan.yaml',revision:'a'.repeat(64),codeFingerprint:'b'.repeat(64),resultPathPolicy:'declared',executionMode:'train_test',planJobCount:7,jobs:[]};
 for(const index of [4,5,6]){
  const job={index,case:'slow',seed:42,globalJobId:'workflow:'+index,outputDir:'work/job'+index,collectionResultCsv:'tmp/result/job'+index+'.csv',lifecycleProtocol:2,
   ...(index>4?{manualDispatch:{workerId:'worker',gpuId:'0',stage:'sent'}}:{})};
  await p.sendDistributedJob(plan,job,'worker','0','command-'+index);
 }
 assert.equal(messages.length,3);assert.equal(messages[1].requireIdleGpu,false);assert.equal(messages[1].options.requireIdleGpu,false);
 assert.ok(messages.every(message=>message.tmuxSessionPrefix==='my-tasks' && message.options.tmuxSessionPrefix==='my-tasks'));
 return messages;
};
