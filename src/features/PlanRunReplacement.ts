import { busyEvidenceFromError, cleanupDigest, cleanupError, CleanupPreview } from "./PlanCleanup";

export type RunReplacement = { key?: string; flow?: "isolate"; previews?: Array<{ index: number; preview: CleanupPreview }>;
  choice?: "rerun_all" | "rerun_missing"; phase?: number; selectedIndices?: number[]; completed?: string[];
  blocked?: Array<{ index: number; reason: string; codes?: string[]; busyOnly?: boolean;
    busy?: Array<Record<string, unknown> & { nodeId?: string }> }>; done?: boolean };
export type RunReplacementPorts = {
  preview(job: any): Promise<CleanupPreview>;
  service: any;
  execute(id: string): Promise<any>;
  verify(preview: CleanupPreview): Promise<void>;
  ask(payload: any): Promise<string>;
  save(): Promise<void>;
  assertCurrent(): void;
  beforeDelete(): Promise<void>;
  hold(jobs: any[]): Promise<void>;
  progress(text: string): void;
};
const targets = (previews: Array<{ index: number; preview: CleanupPreview }>) => previews.flatMap(({ preview }) =>
  preview.rows.filter(row => row.disposition === "isolate").map(row => ({ server: row.node.id,
    connection: row.node.kind === "remote" ? row.node.user + "@" + row.node.host + ":" + row.node.port : "本机",
    path: row.absolutePath, type: row.type })));
const emptyPreview = (index: number): CleanupPreview => ({ token: "blocked-" + index, digest: "", action: "isolate",
  scope: undefined as any, rows: [], blockers: [], verifiedOnly: false, expiresAt: 0, confirmations: 0 });
// 配套 SimpleSFTP 在自身仍有未完成传输/上传时，会在校验任何目标路径之前整体拒绝清理预览（ACTIVE_TRANSFER）。
// 该拒绝是进程级、与 PLAN 无关且明确未动手，因此不能与真实路径冲突混成同一个失败结论。
const TRANSFER_BUSY_CODE = "ACTIVE_TRANSFER";
// 只有某个 job 的“每一条”阻断证据都精确等于该忙码，才能证明它是在核对任何路径之前就被拒绝。
// 空码、未知码、protectedReason 等真实路径证据必须保留阻断身份参与判断，任何一条都不许被过滤掉。
const busyOnlyEvidence = (evidence: string[]) => evidence.length > 0 && evidence.every(code => code === TRANSFER_BUSY_CODE);
// 把配套插件拒绝瞬间的忙快照按“哪一类忙、多少条、安全 stage/相位、何时观测”写成事实明细；
// 数字与条目只来自快照本身，绝不把未知或已终态的东西说成活跃。
const busyDetail = (rows: Array<{ busy?: Array<Record<string, unknown> & { nodeId?: string }> }>) => {
  const parts: string[] = [];
  for (const entry of rows) for (const snap of entry.busy || []) {
    const text = (value: unknown) => String(value ?? "").slice(0, 40);
    const count = (value: unknown) => Number.isInteger(value) ? String(value) : "未知";
    const transfers = (Array.isArray(snap.activeTransfers) ? snap.activeTransfers : []).slice(0, 4)
      .map(row => (text((row as any).operation) || text((row as any).id) || "?") + "：" + (text((row as any).status) || "unknown")
        + (text((row as any).phase) ? "/" + text((row as any).phase) : "")
        // 配套插件已证明只读的观测单独标出，用户不会把“巡检还在跑”误读成“有上传占着文件”。
        + ((row as any).readOnlyObserver === true ? "（只读，不阻断）" : "")
        + ((row as any).selfAttempt === true ? "（本请求自身）" : ""));
    const blocking = Number.isInteger(snap.blockingTransferCount) ? "，其中真正阻断的传输 " + snap.blockingTransferCount : "";
    // 旧版配套封套没有只读/写入拆分：A 按「全部在途传输都阻断」保守回退，必须同时说明口径，
    // 不能把保守口径说成实测拆分；新字段缺失时整体不显示，绝不显示 0 条。
    const legacy = snap.legacyBusyShape === true ? "（旧版配套未区分只读/写入，按全部在途传输计）" : "";
    const observers = Number.isInteger(snap.observerTransferCount) ? "，只读观测 " + snap.observerTransferCount + " 条" : "";
    const selfRows = Number.isInteger(snap.selfAttemptCount) && Number(snap.selfAttemptCount) > 0
      ? "，其中本请求自身 " + snap.selfAttemptCount + " 条（不计入阻断）" : "";
    const uploads = (Array.isArray(snap.uploadOperations) ? snap.uploadOperations : []).slice(0, 4)
      .map(row => text((row as any).stage) ? "stage=" + text((row as any).stage) : "id=" + (text((row as any).id) || "?"));
    const queues = ((snap.uploadQueues as any && Array.isArray((snap.uploadQueues as any).keyHashes)) ? (snap.uploadQueues as any).keyHashes : []).slice(0, 4)
      .map((key: unknown) => text(key));
    parts.push((text(snap.nodeId) || "worker") + " 非终态传输 " + count(snap.activeTransferCount) + (transfers.length ? "[" + transfers.join("、") + "]" : "") + blocking + legacy + observers + selfRows
      + "，上传操作 " + count(snap.uploadOperationCount) + (uploads.length ? "[" + uploads.join("、") + "]" : "")
      + "，保存时上传排队 " + count(snap.uploadQueueCount) + (queues.length ? "[键指纹 " + queues.join("、") + "]" : "")
      + "（观测 " + (text(snap.observedAt) || "未知") + "，实例 " + (text(snap.instanceId) || "未知") + "）");
    if (parts.length >= 6) { parts.push("其余同类观测已省略"); break; }
  }
  return parts.length ? "\n拒绝瞬间配套插件自报的忙明细：" + parts.join("；") : "";
};

/** One flow for normal runs and explicit retries: isolate old outputs first, admit each job independently. */
export async function replaceRunOutputs(ports: RunReplacementPorts, state: RunReplacement, planFile: string,
  jobs: any[], completedIndices: number[], key: string): Promise<{ choice: "rerun_all" | "rerun_missing"; selectedIndices: number[] }> {
  ports.assertCurrent();
  if (state.key && state.key !== key) cleanupError("RUN_DECLARATION_CHANGED", "本次任务或服务器配置已变化，请重新提交并确认路径。");
  state.key = key;
  // 旧“先删除再重跑”意图不迁移到隔离流程；未完成的旧状态按新流程重新预览（旧令牌未执行过任何移动）。
  if (state.previews && state.flow !== "isolate" && !state.done) {
    delete state.previews; delete state.choice; delete state.selectedIndices; delete state.completed; state.phase = 0;
  }
  if (!state.previews) {
    state.flow = "isolate";
    const previews: Array<{ index: number; preview: CleanupPreview }> = [];
    const blocked: Array<{ index: number; reason: string; codes: string[]; busyOnly: boolean;
      busy: Array<Record<string, unknown> & { nodeId?: string }> }> = [];
    let next = 0, fatal: any;
    const read = async () => { while (next < jobs.length && !fatal) {
      const position = next++, job = jobs[position];
      try {
        ports.assertCurrent();
        ports.progress("正在定位任务 " + job.index + " 的已有文件…");
        const preview = await ports.preview(job);
        if (preview.blockers.length || preview.rows.some(row => !["isolate", "absent"].includes(row.disposition))) {
          const anomalies = preview.rows.filter(row => !["isolate", "absent"].includes(row.disposition));
          const reason = [...preview.blockers.map(row => (row.nodeId || "") + "：" + row.code + " " + row.detail),
            ...anomalies.map(row => row.absolutePath + "：" + (row.error || row.protectedReason))].join("；");
          // 每条证据都留身份：缺码 blocker / 缺 error 的 protectedReason 行分别记为未分类，绝不因“看着像忙”而消失。
          const codes = [...preview.blockers.map(row => String(row.code || "").trim() || "UNCLASSIFIED_BLOCKER"),
            ...anomalies.map(row => String(row.error || "").trim() || "PROTECTED_OR_UNCLASSIFIED_PATH")];
          const busy = preview.blockers.filter(row => row.busy).map(row => Object.assign({ nodeId: row.nodeId }, row.busy));
          blocked.push({ index: Number(job.index), reason, codes, busyOnly: busyOnlyEvidence(codes), busy });
          previews[position] = { index: Number(job.index), preview: emptyPreview(Number(job.index)) };
          ports.progress("任务 " + job.index + " 暂不能安全隔离；本轮仅暂停该 job，不等待其他任务：" + reason);
          continue;
        }
        previews[position] = { index: Number(job.index), preview };
      } catch (error: any) {
        try { ports.assertCurrent(); } catch (cancelled) { fatal ||= cancelled; continue; }
        const code = String(error?.apiData?.code || error?.code || "");
        if (code.startsWith("SFTP_") || ["RUN_DECLARATION_CHANGED", "SERVER_IDENTITY_CHANGED", "OUTSIDE_PLAN_CLEANUP_SCOPE"].includes(code)) {
          fatal ||= error; continue;
        }
        // 抛错分支也必须是同一份白名单再投影：远端封套里的 busy 是外部数据，未审字段（原路径/token/自定义嵌套）
        // 不得原样进 state.blocked 或持久化状态；缺 schemaVersion 或非自家投影一律当没有快照。
        const thrownEvidence = busyEvidenceFromError(error);
        const thrownBusy = thrownEvidence ? [Object.assign({ nodeId: String(job?.id || "") }, thrownEvidence)] : [];
        blocked.push({ index: Number(job.index), reason: String(error?.apiData?.detail || error?.message || code || "preview_failed"),
          codes: [code || "UNCLASSIFIED_PREVIEW_ERROR"], busyOnly: code === TRANSFER_BUSY_CODE, busy: thrownBusy });
        previews[position] = { index: Number(job.index), preview: emptyPreview(Number(job.index)) };
        ports.progress("任务 " + job.index + " 无法建立隔离预览；本轮仅暂停该 job：" + blocked[blocked.length - 1].reason);
      }
    } };
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, read));
    if (fatal) throw fatal;
    const exact = targets(previews).map(row => row.server + ":" + row.path);
    if (new Set(exact).size !== exact.length) cleanupError("OUTPUT_REPLACEMENT_OVERLAP");
    if (jobs.length && blocked.length === jobs.length) {
      // 抛错之前先把本轮阻断证据落到本轮状态里：否则整批被拒时具体原因只活在文案里，复核与重试都拿不到结构化证据。
      state.blocked = blocked;
      await ports.save();
      const detail = blocked.map(row => "job " + row.index + "：" + row.reason).join("\n");
      // 每个 job 的全部阻断证据都只是忙码时才升级为“传输忙、可稍后重试”；
      // 只要还有一条真实路径证据（受保护/同物理目标/未知码/缺码），仍按真实隔离冲突处理，不得冒充纯忙。
      if (blocked.every(row => row.busyOnly))
        // 面板建议只拿到 message 文本（cleanupError 把 code 放在 apiData 里），因此把批次码原样带在文末，
        // 让人工复核与面板建议都能区分“已证明整批未动手”与“只是嵌套的忙拒绝”。
        cleanupError("RUN_OUTPUTS_TRANSFER_BUSY", detail + busyDetail(blocked)
          + "\n没有任何 job 可准入；配套 SimpleSFTP 仍有正在进行的传输或上传，未生成隔离清单，未移动文件，也未提交任务。（RUN_OUTPUTS_TRANSFER_BUSY）");
      cleanupError("OUTPUT_ISOLATION_FAILED", detail + "\n没有任何 job 可准入；未移动文件，也未提交任务。");
    }
    state.blocked = blocked; state.previews = previews;
    await ports.save();
  }
  const blockedIndexes = new Set((state.blocked || []).map(row => row.index));
  const all = jobs.map(job => Number(job.index)).filter(index => !blockedIndexes.has(index)), missing = all.filter(index => !completedIndices.includes(index));
  if (state.choice === "rerun_missing" && state.selectedIndices && (state.selectedIndices.length !== missing.length
    || state.selectedIndices.some(index => !missing.includes(index))))
    cleanupError("RUN_SELECTION_CHANGED", "本轮未完成任务范围已变化；请取消后重新确认精确 job 路径，未继续隔离。");
  if (!targets(state.previews).length && !state.choice) state.choice = "rerun_all";
  if (!state.choice) {
    ports.progress("等待选择运行范围并核对将移入隔离区的完整路径…");
    const choice = await ports.ask({ phase: 1, planFile, title: "选择运行范围并核对将移入 clean 隔离区的完整路径", groups: [
      { value: "rerun_all", label: "覆盖并重跑全部", targets: targets(state.previews) },
      { value: "rerun_missing", label: "仅补跑未完成任务", disabled: !missing.length,
        targets: targets(state.previews.filter(row => missing.includes(row.index))) }] });
    if (!["rerun_all", "rerun_missing"].includes(choice)) cleanupError("REPLACEMENT_CANCELLED", "已取消；未移动文件或提交任务。");
    state.choice = choice as RunReplacement["choice"];
    state.selectedIndices = choice === "rerun_missing" ? missing : all;
    await ports.save();
  }
  state.selectedIndices ||= state.choice === "rerun_missing" ? missing : all;
  const selected = state.previews.filter(row => state.selectedIndices!.includes(row.index) && targets([row]).length);
  const exact = targets(selected);
  if (exact.length && (state.phase || 0) < 1) {
    ports.progress("等待确认：旧输出移入 clean 隔离区后立即启动新运行；永久删除稍后单独双确认…");
    if (await ports.ask({ phase: 2, planFile, title: "将以下旧输出移入 clean 隔离区并重跑", groups: [
      { value: "isolate_and_run", label: "隔离并重跑（旧输出不直接删除；永久删除稍后单独两次确认）", targets: exact }] }) !== "isolate_and_run")
      cleanupError("REPLACEMENT_CANCELLED", "已取消；未移动文件或提交任务。");
    for (const { preview } of selected) await ports.service.confirm({ token: preview.token, digest: preview.digest, phase: 1, confirm: true,
      exactTargets: targets([{ index: 0, preview }]).map(row => row.server + ":" + row.path) });
    state.phase = 1; await ports.save();
  }
  ports.assertCurrent();
  if (selected.length) {
    await ports.beforeDelete();
    for (const { preview } of selected) await ports.service.preflightConfirmed(preview.token);
    state.completed ||= []; state.blocked ||= [];
    for (const { index, preview } of selected) {
      ports.assertCurrent();
      if (blockedIndexes.has(index)) continue;
      if (state.completed.includes(preview.token)) {
        try {
          if ((await ports.service.status(preview.token)).state !== "completed") throw new Error("已记录的隔离批次未确认完成");
          await ports.verify(preview);
        } catch (error: any) {
          blockedIndexes.add(index); state.blocked.push({ index, reason: String(error.message || error) }); await ports.save();
        }
        continue;
      }
      ports.progress("正在把已确认旧输出移入 clean 隔离区；已完成 " + state.completed.length + "/" + selected.length + " 批…");
      let result;
      try { result = await ports.execute(preview.token); }
      catch (error) {
        try { result = await ports.service.status(preview.token); } catch {}
        if (result?.state !== "completed") {
          blockedIndexes.add(index); state.blocked.push({ index, reason: String((error as any)?.message || error) }); await ports.save(); continue;
        }
      }
      if (result.state !== "completed" || result.pendingNodes?.length) {
        blockedIndexes.add(index); state.blocked.push({ index, reason: String(result.error || "部分目标尚未确认隔离完成，可重试失败步骤") }); await ports.save(); continue;
      }
      state.completed.push(preview.token); await ports.save();
      try { await ports.verify(preview); }
      catch (error: any) { blockedIndexes.add(index); state.blocked.push({ index, reason: String(error.message || error) }); await ports.save(); }
    }
  }
  const accepted = (state.selectedIndices || []).filter(index => !blockedIndexes.has(index));
  if (jobs.length && !accepted.length)
    cleanupError("OUTPUT_ISOLATION_FAILED", (state.blocked || []).map(row => "job " + row.index + "：" + row.reason).join("\n")
      + "\n没有任何 job 通过隔离准入；旧输出仅移入 clean 区，未提交任务。");
  // 与旧删除流一致：仅当本轮确有旧输出被隔离时才对已准入 job 建立保留围栏；空产物提交不动队列。
  if (selected.length) await ports.hold(jobs.filter(job => accepted.includes(Number(job.index))));
  state.done = true; await ports.save();
  return { choice: state.choice!, selectedIndices: accepted };
}

export const runReplacementKey = (plan: string, revision: string, code: string, jobs: any[], nodes: any[]) =>
  cleanupDigest([plan, revision, code, jobs, nodes]);
