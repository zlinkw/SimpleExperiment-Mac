import { assertFastDeletePreviewSafety, chunkFastDeleteTargets, fastDeleteUpgradeError, isFastDeleteUpgradeCode } from './FastDeleteContract';

type Rpc = (method: string, params: Record<string, any>) => Promise<any>;

/** Unified closed failure: an endpoint without the fast chain never silently falls back. */
async function callUpgradeAware(rpc: Rpc, method: string, params: Record<string, any>): Promise<any> {
  try { return await rpc(method, params); }
  catch (error: any) {
    if (method === 'files.cleanup.preview' && isFastDeleteUpgradeCode(error?.apiData?.code ?? error?.code)) fastDeleteUpgradeError();
    throw error;
  }
}

export type ConfirmedScopeRow = { relativePath: string; directory: boolean; type: 'file' | 'directory'; absolutePath: string;
  missing: boolean; device?: number; inode?: number; isolationName?: string; isolationAbsolutePath?: string };
export type ConfirmedScopeBatch = { token: string; digest: string; node: Record<string, any>; rows: ConfirmedScopeRow[] };
export type ConfirmedScopeOutcome = { relativePath: string; directory: boolean; state: 'completed' | 'failed'; error?: string };

/**
 * v1.9 read-only batched pre-check for the overwrite-cleanup confirmation page.
 * One public preview per ≤5000-target batch (never per file); the returned rows carry the
 * original→isolation mapping the page must display before any user confirmation.
 */
export async function previewConfirmedScopeDeletion(
  rpc: Rpc, node: Record<string, any>,
  entries: Array<{ relativePath: string; directory: boolean }>,
  report: (stage: string) => void = () => {},
): Promise<ConfirmedScopeBatch[]> {
  const batches: ConfirmedScopeBatch[] = [];
  const root = String(node?.root || '').replace(/\/$/, '');
  for (const chunk of chunkFastDeleteTargets(entries)) {
    report(`只读批量预检 ${chunk.length} 条路径`);
    const preview = await callUpgradeAware(rpc, 'files.cleanup.preview', { node, action: 'delete', authorizationMode: 'confirmed_paths',
      observationMode: 'managed_tmux', targets: chunk.map(entry => ({ relativePath: entry.relativePath, type: entry.directory ? 'directory' : 'file' })) });
    assertFastDeletePreviewSafety(preview?.safety, chunk.length);
    if (!preview?.token || !preview?.digest || !Array.isArray(preview.targets) || preview.targets.length !== chunk.length)
      throw new Error('批量删除预检未核实：服务器返回的目标数量不正确，未执行任何删除。');
    const rows: ConfirmedScopeRow[] = chunk.map((entry, index) => {
      const info = preview.targets[index] || {};
      const type = entry.directory ? 'directory' as const : 'file' as const;
      const absolutePath = root + '/' + entry.relativePath;
      if (info.missing === true) return { ...entry, type, absolutePath, missing: true };
      if (info.absolutePath !== absolutePath || info.type !== type)
        throw new Error('批量删除预检未核实：' + entry.relativePath + ' 的路径或类型已变化，请重新核对，未执行任何删除。');
      return { ...entry, type, absolutePath, missing: false, device: info.device, inode: info.inode,
        isolationName: info.isolationName, isolationAbsolutePath: info.isolationAbsolutePath };
    });
    batches.push({ token: preview.token, digest: preview.digest, node, rows });
  }
  return batches;
}

/**
 * Completes one frozen preview batch: confirm×2 with the exact backend target list, one execute
 * for the whole batch, then batched active queries. Lost receipts or isolation residue are reported
 * honestly per path and are never replayed by this plugin.
 */
export async function completeConfirmedScopeDeletion(
  rpc: Rpc, batch: ConfirmedScopeBatch,
  report: (stage: string) => void = () => {},
  timing: { wait?: () => Promise<void>; timeoutMs?: number; now?: () => number } = {},
): Promise<ConfirmedScopeOutcome[]> {
  const indexes = new Map(batch.rows.map((row, index) => [row, index]));
  const results = new Map<string, ConfirmedScopeOutcome>(batch.rows.map(row => [row.relativePath, { relativePath: row.relativePath, directory: row.directory, state: 'completed' as const }] as [string, ConfirmedScopeOutcome]));
  const present = batch.rows.filter(row => !row.missing);
  if (!present.length) return [...results.values()];
  const exactTargets = present.map(row => row.absolutePath);
  const request = { token: batch.token, digest: batch.digest };
  for (const phase of [1, 2]) await rpc('files.cleanup.confirm', { ...request, phase, confirm: true, exactTargets });
  present.forEach(row => results.get(row.relativePath)!.state = 'failed');
  let sendError = '';
  try { await rpc('files.cleanup.execute', { ...request, index: indexes.get(present[0]) }); }
  catch (error) { sendError = error instanceof Error ? error.message : String(error); }
  // The execute response is only transport evidence; one batched active query per round resolves every entry.
  const now = timing.now || Date.now, inactivityMs = timing.timeoutMs ?? 15_000;
  let deadline = now() + inactivityMs, resolvedCount = 0;
  for (;;) {
    const snapshot = await rpc('files.cleanup.status', { token: batch.token }).catch(() => undefined);
    let resolved = 0;
    if (snapshot) {
      for (const row of present) {
        const index = indexes.get(row)!;
        const observation = (snapshot.observations || [])[index] || {};
        const state = observation.state || (snapshot.states || [])[index];
        if (state === 'completed') { resolved++; results.get(row.relativePath)!.state = 'completed'; delete results.get(row.relativePath)!.error; }
        else if (state === 'unknown') results.get(row.relativePath)!.error = '隔离名残留或状态未核实：' + String(observation.isolationStatus || observation.code || 'unknown');
        else if (state) results.get(row.relativePath)!.error = '回执未核实：' + String(state);
      }
      if (resolved === present.length) return [...results.values()];
      if (resolved > resolvedCount) { resolvedCount = resolved; deadline = now() + inactivityMs; report(`批量删除进行中：已核实 ${resolved}/${present.length} 条路径`); }
      if (!snapshot.batchExecuting) break;
      if (now() >= deadline) { report('批量删除仍在服务器处理中；本轮等待已结束，不会重复发送，请稍后刷新实际状态'); break; }
    } else if (sendError || now() >= deadline) break;
    await (timing.wait || (() => new Promise(resolve => setTimeout(resolve, 500))))();
  }
  for (const row of present) {
    const result = results.get(row.relativePath)!;
    if (result.state !== 'completed')
      result.error = (result.error || '回执未核实') + (sendError ? '；执行请求回执丢失：' + sendError : '') + '；不会自动重发，请刷新实际状态后由你决定是否继续';
  }
  return [...results.values()];
}

/** Called only after the tree's two exact-path confirmations. No transfer-ledger recovery. */
export async function deleteConfirmedScopeCopy(
  rpc: Rpc, node: Record<string, any>, relativePath: string, directory: boolean,
  report: (stage: string) => void = () => {},
  timing: { wait?: () => Promise<void>; timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
  const call: Rpc = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      report(`正在执行 ${method}：${relativePath}`);
      try { return await rpc(method, params); }
      catch (error: any) {
        const detail = error?.message || String(error);
        // Only retire and repeat a read whose evidence was invalidated. Never replay
        // previews, confirmations, execute/check requests, or a changed connection.
        const invalidated = method === 'files.cleanup.inspect' && /\bFILE_INDEX_INVALIDATED_DURING_READ\b/.test(detail);
        if (!invalidated || attempt >= 2) throw Object.assign(new Error(`${method}：${detail}${invalidated ? '；三次实时读取期间状态持续变化，本轮尚未核实，不会自动重复删除。' : ''}`),
          { apiCode: error?.apiCode, apiData: error?.apiData });
        report(`文件状态同时发生变化，正在重新读取并核实 ${relativePath}（${attempt + 2}/3）`);
        await (timing.wait || (() => new Promise(resolve => setTimeout(resolve, 250))))();
      }
    }
  };
  const target = { relativePath, type: directory ? 'directory' : 'file' };
  const refreshDeletedTarget = async () => {
    const observed = await call('files.cleanup.inspect', { node, target, presenceOnly: true, allowMissing: true, observeExecutors: true });
    if (observed?.ok !== true || observed.executorsChecked !== true || !Array.isArray(observed.executors)
      || observed.executors.length || observed.target?.missing !== true)
      throw new Error('删除后的文件状态未核实：目标仍存在、已重新创建或查询未完成；请刷新，不会自动重复删除。');
  };
  const presence = await call('files.cleanup.inspect', { node, target, presenceOnly: true, allowMissing: true, observeExecutors: true });
  if (presence?.ok !== true || presence.executorsChecked !== true || !Array.isArray(presence.executors))
    throw new Error('删除查询失败：未取得实际文件和清理窗口状态。');
  if (presence.executors.length) throw new Error('对应清理窗口仍在处理；请刷新文件列表，不重复删除。');
  if (presence.target?.missing === true) return;
  const preview = await callUpgradeAware(rpc, 'files.cleanup.preview', { node, action: 'delete', authorizationMode: 'confirmed_paths',
    observationMode: 'managed_tmux', targets: [{ ...target, destination: 'clean_dir/' + relativePath }] });
  assertFastDeletePreviewSafety(preview?.safety, 1);
  if (preview.targets?.length !== 1) throw new Error('删除未核实：返回的目标数量不正确。');
  if (preview.targets[0].missing === true) { await refreshDeletedTarget(); return; }
  const absolutePath = node.root.replace(/\/$/, '') + '/' + relativePath;
  if (preview.targets[0].absolutePath !== absolutePath || preview.targets[0].type !== target.type)
    throw new Error('删除未核实：目标路径或类型已变化，请重新确认。');
  const request = { token: preview.token, digest: preview.digest };
  for (const phase of [1, 2]) await call('files.cleanup.confirm', { ...request, phase, confirm: true, exactTargets: [absolutePath] });
  let sendError = '';
  let admissionWaiting = false;
  try { admissionWaiting = (await call('files.cleanup.execute', { ...request, index: 0 }))?.state === 'waiting'; }
  catch (error) { sendError = error instanceof Error ? error.message : String(error); }
  // Even a successful execution response is only transport evidence. Query the actual executor and filesystem.
  const now = timing.now || Date.now, inactivityMs = timing.timeoutMs ?? 15_000;
  let deadline = now() + inactivityMs, removedEntries = 0, removedBytes = 0;
  do {
    const proof = await call('files.cleanup.check', { token: preview.token, index: 0 });
    if (proof?.ok !== true) throw new Error('删除查询失败：无法核实目标状态。');
    if (proof.state === 'completed') { await refreshDeletedTarget(); return; }
    if (proof.state === 'pending' && admissionWaiting) {
      // Only an explicit not-started admission response permits another start
      // request. Lost responses never enter this branch.
      admissionWaiting = (await call('files.cleanup.execute', { ...request, index: 0 }))?.state === 'waiting';
      report('服务器正在处理另一项清理，等待本次目标进入执行');
    } else {
      if (proof.state !== 'executing') throw new Error(`删除未核实：${proof.queryError || proof.code || proof.state || '状态未知'}${sendError ? '；' + sendError : ''}`);
      admissionWaiting = false;
      const entries = Number(proof.progress?.removedEntries), bytes = Number(proof.progress?.removedBytes);
      if (Number.isFinite(entries) && entries > removedEntries || Number.isFinite(bytes) && bytes > removedBytes) {
        removedEntries = Math.max(removedEntries, Number.isFinite(entries) ? entries : 0);
        removedBytes = Math.max(removedBytes, Number.isFinite(bytes) ? bytes : 0);
        deadline = now() + inactivityMs;
      }
      report(`正在删除：已清除 ${removedEntries} 项、${removedBytes} 字节`);
    }
    // An observed live executor is authoritative even while one filesystem
    // removal blocks. Silence cannot turn it into a failed or replayable delete.
    if (now() >= deadline && !admissionWaiting) report('清理窗口仍在处理，等待实际文件状态；不会重复删除');
    if (now() >= deadline && admissionWaiting) break;
    await (timing.wait || (() => new Promise(resolve => setTimeout(resolve, 500))))();
  } while (true);
  throw new Error('清理窗口仍在处理；本轮等待已结束，请刷新文件列表，不重复删除。');
}
