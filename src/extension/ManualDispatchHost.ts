import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { dispatchManualJobs, dispatchReadyManualJobs, ManualDispatchRequest, ManualDispatchPorts } from "../features/ManualJobDispatch";
import { stopPulledTask } from "../features/PulledTaskControl";
import { PlanRunHost } from "./PlanRunHost";
import { supportsPlanCodeScope, verifyWorkerPlanSource, verifyLocalPlanSource } from "./PlanCodeScopeHost";

export class ManualDispatchHost {
  private gpuSnapshot: any;
  constructor(private readonly host: any, private readonly root: string) {}
  ports(): ManualDispatchPorts {
    const h=this.host, stopEpoch=h.distributedPlanStopEpoch;
    const targets=()=>JSON.stringify([h.effectiveConnectionMode?.(),h.workerActionTargets().map((w:any)=>
      [w.id,w.host,w.port,w.user,w.project_dir,w.local_agent_url,w.agent_runtime_dir,w.conda_env])]);
    const targetKey=targets();
    return {
      load:()=>h.loadDistributedQueue(this.root), save:async(q,options)=>{const receipt=await h.saveDistributedQueue(this.root,q,options||{});h.postState();return receipt;},
      assertCurrent:()=>{if(targets()!==targetKey||vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!==this.root||h.distributedPlanStopEpoch!==stopEpoch)throw Error("项目、连接或停止请求已变化，未继续派发。");},
      online:id=>h.enabledWorkerConfigs().some((w:any)=>w.id===id)&&h.lastWorkerProbes?.[id]?.status==="ok",
      supports:id=>h.lastWorkerProbes?.[id]?.capabilities?.endpoints?.manualDispatch===1,
      newCommandId:()=>randomUUID().replace(/-/g,""),
      prepare:async plan=>{
        h.assertExecutionWorkersReady();h.assertExecutionAgentProjectsReady({options:{workers:h.workerActionTargets()}});
        const gpu=this.gpuSnapshot||await h.client.getGpu({userInitiated:true});
        for(const j of plan.jobs.filter(j=>j.manualDispatch?.stage==="preparing")){
          const p=j.manualDispatch!,rows=Array.isArray(gpu[p.workerId])?gpu[p.workerId]:[];
          if(!rows.some((r:any)=>String(r.index??r.gpu_id??r.gpuId??r.id)===p.gpuId))throw Error("目标 GPU 不可见："+p.workerId+" · GPU "+p.gpuId+"；未停止原任务或审核产物。");
        }
        const placements=[...new Set<string>(plan.jobs.filter(j=>j.manualDispatch?.stage==="preparing").map(j=>j.manualDispatch!.workerId))];
        if(placements.length&&placements.every(id=>supportsPlanCodeScope(h,id))){
          for(const id of placements)await verifyLocalPlanSource(this.root,await verifyWorkerPlanSource(h,id,plan),h.projectFileObservationIndex?.());
        }else{
          await h.ensureCodeReadyForRun(h.captureProjectContext(),[]);
          if(h.lastCodeSyncState?.fingerprint!==plan.codeFingerprint)throw Error("需更新目标 Agent/Scheduler 按本 PLAN 依赖核实源码；项目整体版本变化不能证明本 job 的源码变化。");
        }
        await Promise.all(h.enabledWorkerConfigs().map(async(w:any)=>{
          if(h.readWorkerTaskSnapshot)await h.readWorkerTaskSnapshot(w.id,{fresh:true});
          else h.lastWorkerTaskSnapshots.set(this.root+"\u0000"+w.id,{...await h.client.getWorkerTasks(w.id),fetchedAt:new Date().toISOString()});
        }));
      },
      stop:async(p,j)=>{await stopPulledTask(h.client,p,j,randomUUID().replace(/-/g,""));},
      review:(p,j)=>this.review(p,j),send:(p,j)=>h.sendDistributedJob(p,j,j.workerId,j.gpuId,j.commandId),
      tick:()=>dispatchReadyManualJobs(this.ports()),
    };
  }
  async dispatch(params:any,fromUi=false){
    const h=this.host;
    if(!fromUi&&params.confirm!==true)throw Error("CONFIRM_REQUIRED：请确认所选 job、服务器和 GPU。");
    const workflowId=String(params.workflowId||params.planId||""),indices=Array.isArray(params.indices)?params.indices:[params.jobIndex];
    const key=this.root+"\0"+workflowId;if(h.manualDispatchInFlight.has(key))throw Error("这批任务正在处理，请勿重复点击。");
    if(h.manualDispatchInFlight.has(this.root+"\0server-queue"))throw Error("剩余 job 正在按配额派发服务器队列，请等待本批结果。");
    h.manualDispatchInFlight.add(key);
    try {
    if(h.distributedQueueTickPromise)await h.distributedQueueTickPromise;
    let workerId=String(params.workerId||""),gpuId=params.gpuId===undefined?"":String(params.gpuId);
    if(fromUi&&!workerId){
      const saved=await h.loadDistributedQueue(this.root),plan=saved.plans.find((p:any)=>p.id===workflowId);
      const placements=indices.map((i:number)=>plan?.jobs.find((j:any)=>j.index===i)?.manualDispatch);
      const first=placements[0];
      if(first?.stage==="preparing"&&placements.every((p:any)=>p?.workerId===first.workerId&&p?.gpuId===first.gpuId)){
        workerId=first.workerId;gpuId=first.gpuId;
      }
    }
    if(fromUi&&!workerId){
      const picked=await vscode.window.showQuickPick<any>(h.enabledWorkerConfigs().map((w:any)=>({label:w.displayName||w.id,description:w.id+(h.lastWorkerProbes?.[w.id]?.status==="ok"?" · 已连接":" · 未连接"),id:w.id})),{title:"手动派发：选择服务器",ignoreFocusOut:true});
      if(!picked)return {status:"cancelled"};workerId=picked.id;
    }
    if(!h.enabledWorkerConfigs().some((w:any)=>w.id===workerId))throw Error("目标 Worker 未启用或不存在："+workerId);
    if(fromUi&&!gpuId){
      let snapshot=h.client.currentState?.().gpu||h.lastRealtimeState?.gpu||{};
      try{snapshot=await h.client.getGpu({userInitiated:true});this.gpuSnapshot=snapshot;}catch{}
      const rows=Array.isArray(snapshot[workerId])?snapshot[workerId]:[];
      const tasks=h.lastWorkerTaskSnapshots?.get(this.root+"\u0000"+workerId)?.tasks||[];
      const picked=await vscode.window.showQuickPick<any>(rows.map((r:any)=>({label:"GPU "+String(r.index??r.gpu_id??r.gpuId??r.id),id:String(r.index??r.gpu_id??r.gpuId??r.id),
        description:String(r.name||"")+" · 显存 "+String(r.memoryUsedMb??r.memoryUsed??r.memory_used_mb??"?")+"/"+String(r.memoryTotalMb??r.memoryTotal??r.memory_total_mb??"?")+" MB · 利用率 "+String(r.utilizationPercent??r.utilization??r.utilization_gpu??"?")+"% · 任务 "+tasks.filter((t:any)=>!['completed','failed','cancelled'].includes(t.status)&&String(t.gpuId??t.observation?.tmux?.gpuId??"")===String(r.index??r.gpu_id??r.gpuId??r.id)).length})),{title:"选择 GPU（忙卡可选；纳入管理的分支会在统一派发队列中等配额，不会无限绕过）",ignoreFocusOut:true});
      if(!picked)return {status:"cancelled"};gpuId=picked.id;
    }
    return await dispatchManualJobs(this.ports(),{workflowId,indices,workerId,gpuId,expectedCommands:params.expectedCommands,stopRunning:fromUi||params.stopRunning===true} as ManualDispatchRequest);
    }
    finally{h.manualDispatchInFlight.delete(key);h.postState();void h.tickDistributedQueue();}
  }
  async review(plan:any,jobs:any[]){
    const h=this.host,body={planFile:plan.planFile,planRevision:plan.revision,options:{},distributedSkipJobIndices:[],
      workerSubmissionSnapshots:[],runReplacement:{}};
    const validation={execution_mode:plan.executionMode,jobs:jobs.map(j=>({index:j.index,case:j.case,seed:j.seed,output_dir:j.outputDir,result_csv:j.collectionResultCsv}))};
    await h.assertPlanSubmissionWorkers(body,{validation});
    try {await new PlanRunHost(h,this.root).replace(plan,body,validation);
      // r82：审核结果成对透传——accepted 可派发，blocked（隔离未完成/核验未知，带 stage/code）交派发层
      // 打 job 级阻断标记。此前只回 assignedExperimentIndices，阻断 job 被派发层当普通未完成 job 处理，
      // 正是现场"排除又派发"的入口之一；取消仍返回 false（未移动任何文件）。
      const blocked=(body as any).runReplacement?.blocked||[];
      return {accepted:(body as any).assignedExperimentIndices||[],
        blocked:blocked.map((row:any)=>({index:Number(row.index),reason:String(row.reason||""),stage:row.stage,code:row.code,operationId:row.operationId}))};}
    catch(error:any){if(error.apiData?.code==="REPLACEMENT_CANCELLED")return false;throw error;}
  }
}
