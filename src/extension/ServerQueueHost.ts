import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { remainingQueueJobs, serverQueueCards, quotaQueuePlacements } from "../features/ServerQueueDispatch";
import { ManualDispatchHost } from "./ManualDispatchHost";
import { quotaSettings } from "../features/GpuQuotaScheduling";

/** An explicit button freezes remaining jobs; no PLAN-wide persistent prequeue switch. */
export class ServerQueueHost {
  constructor(private readonly h: any, private readonly root: string) {}
  async dispatch(params: any, fromUi=false) {
    const h=this.h, context=h.captureProjectContext(), epoch=h.distributedPlanStopEpoch;
    if (!fromUi && params.confirm!==true) throw Error("CONFIRM_REQUIRED：请确认剩余 job 按逐卡配额进入服务器队列。");
    const ids=params.all===true ? undefined : [params.workflowId||params.planId,...(Array.isArray(params.workflowIds)?params.workflowIds:[])].filter(Boolean);
    if (ids && !ids.length) throw Error("请选择 PLAN 或明确指定全部剩余 job。");
    const targets=()=>JSON.stringify([h.workerActionTargets(),h.schedulerSettings(),h.enabledWorkerConfigs().map((w:any)=>[w.id,w.gpuJobsPerCard,w.gpuCardOverrides,w.gpuMaxConcurrentCards])]);
    const binding=targets(), key=this.root+"\0server-queue", reserved:any[]=[];
    const current=()=>{if(!h.projectContextIsCurrent(context)||context.root!==this.root||vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!==this.root||targets()!==binding||h.distributedPlanStopEpoch!==epoch)throw Error("项目、GPU 配额或连接已变化，未继续派发服务器队列。");};
    if(h.manualDispatchInFlight.size)throw Error("已有手动派发正在处理，请等待本批结果。");
    h.manualDispatchInFlight.add(key);
    const batchId=randomUUID();
    try {
      if(h.distributedQueueTickPromise)await h.distributedQueueTickPromise;
      current();h.assertExecutionWorkersReady();h.assertExecutionAgentProjectsReady({options:{workers:h.workerActionTargets()}});
      const queue=await h.loadDistributedQueue(this.root);current();
      if(ids && ids.some((id:string)=>!queue.plans.some((plan:any)=>plan.id===id)))throw Error("所选 PLAN 已变化，整批未派发。");
      const selected=queue.plans.filter((plan:any)=>!ids||ids.includes(plan.id)).flatMap((plan:any)=>remainingQueueJobs(plan).map(job=>({plan,job})));
      if(!selected.length)return {status:"completed",message:"没有尚未派发的剩余 job；已在运行或服务器排队的任务保持原状。"};
      const gpu=await h.client.getGpu({userInitiated:true});current();
      const workers=h.enabledWorkerConfigs();
      if(workers.some((w:any)=>h.lastWorkerProbes?.[w.id]?.capabilities?.endpoints?.manualDispatch!==1||h.lastWorkerProbes?.[w.id]?.capabilities?.endpoints?.gpuQuotaScheduling!==1))
        throw Error("Worker 未支持逐卡手动排队协议，未派发。");
      for(const worker of workers){
        const policy=quotaSettings(h.schedulerSettings(),worker,gpu?.[worker.id]||[]), capabilities=h.lastWorkerProbes?.[worker.id]?.capabilities?.endpoints;
        if(policy.gpuCardOverrides && capabilities?.gpuCardQuotaScheduling!==1 || policy.gpuMaxConcurrentCards!==undefined && capabilities?.gpuCardLimitScheduling!==1)
          throw Error("Worker 未支持当前逐卡配额或占卡上限协议，整批未派发。");
      }
      const cards=serverQueueCards(h.schedulerSettings(),workers,gpu);
      let distribution=quotaQueuePlacements(selected.length,cards);
      const identity=(plan:any,job:any)=>JSON.stringify([plan.id,plan.projectId,plan.revision,plan.codeFingerprint,job.index,job.outputDir,job.collectionResultCsv]);
      selected.forEach((item:any,index:number)=>reserved.push({...item,identity:identity(item.plan,item.job),placement:distribution.placements[index]}));
      const ports=new ManualDispatchHost(h,this.root).ports(), approved=new Set<string>();
      for(const planId of new Set(reserved.map(item=>item.plan.id))){
        current();const plan=reserved.find(item=>item.plan.id===planId).plan;
        const jobs=reserved.filter(item=>item.plan.id===planId).map(item=>({...item.job,
          manualDispatch:{...item.placement,stage:"preparing",origin:"server_queue",batchId}})),input={...plan,jobs};
        // Review may retain some jobs. Verify every eligible destination before
        // recomputing the exact quota split for the approved subset.
        const prepareInput={...input,jobs:[...jobs,...cards.map(card=>({...jobs[0],manualDispatch:{...card,stage:"preparing"}}))]};
        await ports.prepare(prepareInput);current();const reviewed=await ports.review(input,jobs);current();
        if(reviewed===false)throw Error("已取消产物审核；本批剩余 job 未派发。");
        for(const job of jobs)if(!Array.isArray(reviewed)||reviewed.includes(job.index))approved.add(identity(plan,job));
      }
      distribution=quotaQueuePlacements(approved.size,cards);
      let placementIndex=0;for(const item of reserved)if(approved.has(item.identity))item.placement=distribution.placements[placementIndex++];
      await h.saveDistributedQueue(this.root,undefined,{controlMutation:true,mutateLatest:(latest:any)=>{
        current();
        for(const item of reserved){const plan=latest.plans.find((p:any)=>p.id===item.plan.id),job=plan?.jobs.find((j:any)=>j.index===item.job.index);
          if(!job||identity(plan,job)!==item.identity||!remainingQueueJobs(plan).includes(job))throw Error("排队批次已变化，未提交新任务。");}
        for(const item of reserved){const plan=latest.plans.find((p:any)=>p.id===item.plan.id),job=plan.jobs.find((j:any)=>j.index===item.job.index);
          if(approved.has(item.identity)){job.nextCommandId=randomUUID().replaceAll("-","");job.manualDispatch={...item.placement,stage:"ready",origin:"server_queue",batchId};job.localQueueOnly=true;}
          else Object.assign(job,{manualDispatch:undefined,retainExistingOutputs:true,status:"cancelled",manualDispatchNotice:"保留已有产物，本次未派发。"});}
        return {...latest};
      }});
      await ports.tick();
      return {status:"submitted",message:`已按逐卡 job 配额将 ${approved.size} 个剩余 job 派入服务器队列；比例 `+distribution.allocations.map(card=>`${card.workerId}/GPU ${card.gpuId}=${card.weight}（本批 ${card.count}）`).join("、"),allocations:distribution.allocations};
    } finally {
      h.manualDispatchInFlight.delete(key);h.postState();if(h.projectContextIsCurrent(context))void h.tickDistributedQueue().catch(()=>{});
    }
  }
}
