/** A source check is read-only. One POST; every recovery observes that operation. */
export async function waitForPlanCodeScopeOperation(ports: {
  operationId: string; query: any; signal?: AbortSignal;
  submit(): Promise<any>; observe(): Promise<any>; terminal(): void;
  now?(): number; pause?(): Promise<void>;
}): Promise<any> {
  const now=ports.now || Date.now, started=now();
  let latest:any;
  const pending=(reason:string)=>Object.assign(new Error(`PLAN_SOURCE_VERIFICATION_PENDING: 只读源码核验尚未取得确定结果；operationId=${ports.operationId}；未提交训练。后续仅查询原核验，不重复启动。${reason}`),
    {operationId:ports.operationId,readOnly:true,remoteExecution:"not_started",timings:latest?.timings,progress:latest?.progress});
  const identity=(value:any)=>{
    for(const key of ['projectId','planFile','planRevision','codeFingerprint'])
      if(value[key]!==ports.query[key]) throw Error(`PLAN_SOURCE_OPERATION_IDENTITY_MISMATCH: ${key}`);
  };
  let start:any;
  try { start=await ports.submit(); }
  catch(error:any){
    ports.signal?.throwIfAborted();
    if(error.httpStatus>=400 && error.httpStatus<500){ports.terminal();throw error;}
    // A lost acknowledgement does not authorize another POST.
  }
  if(start?.executionSource && start.ok===true){identity(start);ports.terminal();return {...start,sourceOperation:{readOnly:true,remoteExecution:"not_started",legacySynchronous:true,totalClientMs:now()-started}};}
  let sequence=-1, lastProgressAt=now();
  const pause=ports.pause || (()=>new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);ports.signal?.removeEventListener('abort',abort);reject(ports.signal?.reason);};
    const timer=setTimeout(()=>{ports.signal?.removeEventListener('abort',abort);resolve();},500);
    ports.signal?.addEventListener('abort',abort,{once:true});
    if(ports.signal?.aborted)abort();
  }));
  for(;;){
    ports.signal?.throwIfAborted();
    const requestedAt=now();let state:any;
    try { state=await ports.observe(); }
    catch(error:any){ports.signal?.throwIfAborted();throw pending(String(error.message||error));}
    identity(state);
    if(state.operationId!==ports.operationId || state.type!=="plan-code-scope" || state.readOnly!==true
      || state.remoteExecution!=="not_started" || state.sourceDigest!==(ports.query.executionSource?.digest||""))
      throw Error("PLAN_SOURCE_OPERATION_IDENTITY_MISMATCH: operation binding");
    if(!Number.isSafeInteger(state.progressSequence)||state.progressSequence<0)throw Error("PLAN_SOURCE_OPERATION_PROGRESS_INVALID");
    latest=state;
    if(state.progressSequence>sequence){sequence=state.progressSequence;lastProgressAt=now();}
    if(state.status==="completed"){
      identity(state.result);ports.terminal();
      return {...state.result,sourceOperation:{operationId:ports.operationId,readOnly:true,remoteExecution:"not_started",timings:state.timings,
        progress:state.progress,resultFetchMs:now()-requestedAt,totalClientMs:now()-started}};
    }
    if(state.status==="failed"){
      ports.terminal();throw Object.assign(new Error(`PLAN_SOURCE_VERIFICATION_FAILED: ${state.error||'未提供原因'}；operationId=${ports.operationId}；只读核验，未提交训练。`),
        {operationId:ports.operationId,readOnly:true,remoteExecution:"not_started",timings:state.timings});
    }
    if(!["queued","running"].includes(state.status))throw pending("未知核验状态："+String(state.status));
    // Status polls, elapsed time and identical payloads are not processing evidence.
    if(now()-lastProgressAt>=20000)throw pending("20 秒未观察到新的实际处理进展；服务端核验未被本次查询停止。");
    await pause();
  }
}
