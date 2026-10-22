import { ProgressInactivity } from "../core/ProgressInactivity";

/** Registration is one request; completion comes from bounded active queries. */
export async function waitForCodeSyncProof(ports: {
  operationId: string; workerId: string; manifestDigest: string; scopeSignature: string;
  submit(): Promise<any>; query(): Promise<any>; assertCurrent(): void; progress?(text: string): void;
  idleMs?: number; pollMs?: number;
}): Promise<any> {
  const idleMs = ports.idleMs ?? 30000;
  let lastError = "", rejectIdle!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectIdle = reject; });
  const inactivity = new ProgressInactivity(idleMs, () => {
    // A successful running observation is not a failed file verification.
    // Only loss of the ability to query ends this wait as unknown.
    if (lastError) rejectIdle(new Error(`${ports.workerId}：同步登记结果未知；原操作 ${ports.operationId} 保留，未重复上传。查询原因：${lastError}`));
    else { try { ports.progress?.(`${ports.workerId}：文件核实暂未取得新进展，继续查询原操作 ${ports.operationId}`); } catch { /* Advisory only. */ } }
  }, Date.now, true);
  // Losing this response is harmless. Never post a second registration in this wait.
  void Promise.resolve().then(ports.submit).catch(() => { /* Active queries own the outcome, including a late lost POST response. */ });
  try {
    for (;;) {
      ports.assertCurrent();
      let state: any;
      try { state = await Promise.race([ports.query(), timeout]); }
      catch (error: any) {
        lastError = String(error.message || error);
        if (Date.now() - inactivity.lastProgressAt >= idleMs)
          throw new Error(`${ports.workerId}：同步登记结果未知；原操作 ${ports.operationId} 保留，未重复上传。查询原因：${lastError}`);
        await Promise.race([new Promise(resolve => setTimeout(resolve, ports.pollMs ?? 500)), timeout]); continue;
      }
      ports.assertCurrent();
      lastError = "";
      if (state.operationId !== ports.operationId || state.workerId !== ports.workerId
        || state.manifestDigest !== ports.manifestDigest || state.scopeSignature !== ports.scopeSignature)
        throw new Error(`Worker ${ports.workerId} 同步登记身份不一致：${ports.operationId}`);
      inactivity.update({ phase: "code-sync-proof", processedFiles: state.processedFiles, processedBytes: state.processedBytes });
      try { ports.progress?.(`${ports.workerId}：核对同步文件 ${Number(state.processedFiles) || 0}/${Number(state.totalFiles) || 0}`); } catch { /* Advisory only. */ }
      if (state.status === "completed") return state.result;
      if (state.status === "failed") throw new Error(`${ports.workerId} 同步登记失败：${state.error || "未提供原因"}；操作 ${ports.operationId}`);
      if (!["queued", "accepted", "running"].includes(state.status))
        throw new Error(`${ports.workerId}：同步登记结果未知；原操作 ${ports.operationId} 保留，未重复上传。${state.queryError || state.status || "缺少状态"}`);
      await Promise.race([new Promise(resolve => setTimeout(resolve, ports.pollMs ?? 500)), timeout]);
    }
  } finally { inactivity.dispose(); }
}
