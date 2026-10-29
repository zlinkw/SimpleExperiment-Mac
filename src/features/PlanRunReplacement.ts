import { busyEvidenceFromError, cleanupDigest, cleanupError, isolationReceiptComplete, CleanupPreview } from "./PlanCleanup";
import { type EmptyParentPreview } from "./IsolationEmptyParents";

export type RunReplacement = { key?: string; flow?: "isolate"; previews?: Array<{ index: number; preview: CleanupPreview }>;
  choice?: "rerun_all" | "rerun_missing"; phase?: number; selectedIndices?: number[]; completed?: string[];
  emptyParents?: Record<string, EmptyParentPreview[]>;
  // r82（0.5.414）：每条阻断必须带产生阶段——preview=预览拒绝/异常，execute=执行拒绝或结果不完整
  // （含状态兜底失败），verify=隔离后源核验失败。旧持久化条目可缺 stage，消费端按"未核实"保守处理。
  blocked?: Array<{ index: number; reason: string; stage?: "preview" | "execute" | "verify"; code?: string; operationId?: string; codes?: string[]; busyOnly?: boolean;
    busy?: Array<Record<string, unknown> & { nodeId?: string }> }>; done?: boolean };
export type RunReplacementBlockedFact = { index: number; reason: string; stage: "preview" | "execute" | "verify"; code?: string; codes?: string[]; busyOnly?: boolean; operationId?: string };
export type RunReplacementPorts = {
  preview(job: any): Promise<CleanupPreview>;
  service: any;
  execute(id: string): Promise<any>;
  verify(preview: CleanupPreview): Promise<void>;
  // r87 块4：后台清隔离副本的旁路提交（仅"本次 rerun_all + 完成回执齐备"时触发，不进派发 await 链）。
  // 返回真实受理状态（accepted≠completed）；调用方 fire-and-forget，失败只落操作日志与通知。
  prepareEmptyParents?(preview: CleanupPreview): Promise<EmptyParentPreview[]>;
  confirmEmptyParents?(previews: EmptyParentPreview[], phase: number): Promise<void>;
  autoDeleteIsolated?(operationId: string, parents?: EmptyParentPreview[]): Promise<{ state: "accepted" | "failed" | "unknown"; operationId?: string; message?: string }>;
  ask(payload: any): Promise<string>;
  save(): Promise<void>;
  assertCurrent(): void;
  beforeDelete(): Promise<void>;
  hold(jobs: any[]): Promise<void>;
  progress(text: string): void;
  // 批次接线注入：只把“对话确认+精确路径确认”送进全局对话道（同一时刻至多一个确认页）；
  // 预览、rename 隔离、核验与 hold 等机械链不进这条道，绝不能占住别的 PLAN 的提交。
  interactive?(work: () => Promise<void>): Promise<void>;
  // 批次接线注入：同批隔离机械 I/O 读写协调（read=预检观察链可并发；write=SFTP 计忙段互斥，
  // 批内 FIFO）。未注入（单 PLAN/非批次）时直接执行、零新语义；绝不用它包裹人工确认或对话道。
  isolation?<T>(kind: "read" | "write", work: () => Promise<T>): Promise<T>;
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
  jobs: any[], completedIndices: number[], key: string): Promise<{ choice: "rerun_all" | "rerun_missing"; selectedIndices: number[];
  blocked: RunReplacementBlockedFact[] }> {
  ports.assertCurrent();
  if (state.key && state.key !== key) cleanupError("RUN_DECLARATION_CHANGED", "本次任务或服务器配置已变化，请重新提交并确认路径。");
  state.key = key;
  const gate = ports.interactive || (async (work: () => Promise<void>) => work());
  const lane = <T>(kind: "read" | "write", work: () => Promise<T>): Promise<T> => ports.isolation ? ports.isolation(kind, work) : work();
  // 旧“先删除再重跑”意图不迁移到隔离流程；未完成的旧状态按新流程重新预览（旧令牌未执行过任何移动）。
  if (state.previews && state.flow !== "isolate" && !state.done) {
    delete state.previews; delete state.choice; delete state.selectedIndices; delete state.completed; state.phase = 0;
  }
  if (!state.previews) {
    state.flow = "isolate";
    const previews: Array<{ index: number; preview: CleanupPreview }> = [];
    const blocked: Array<{ index: number; reason: string; stage: "preview"; code?: string; codes: string[]; busyOnly: boolean;
      busy: Array<Record<string, unknown> & { nodeId?: string }> }> = [];
    let next = 0, fatal: any;
    const read = async () => { while (next < jobs.length && !fatal) {
      const position = next++, job = jobs[position];
      try {
        ports.assertCurrent();
        ports.progress("正在定位任务 " + job.index + " 的已有文件…");
        // 预检观察链整体是只读读者：批内并发，只排在同批他 Plan 的写段之后（FIFO），不与其冲撞。
        const preview = await lane("read", () => ports.preview(job));
        if (preview.blockers.length || preview.rows.some(row => !["isolate", "absent"].includes(row.disposition))) {
          const anomalies = preview.rows.filter(row => !["isolate", "absent"].includes(row.disposition));
          const reason = [...preview.blockers.map(row => (row.nodeId || "") + "：" + row.code + " " + row.detail),
            ...anomalies.map(row => row.absolutePath + "：" + (row.error || row.protectedReason))].join("；");
          // 每条证据都留身份：缺码 blocker / 缺 error 的 protectedReason 行分别记为未分类，绝不因“看着像忙”而消失。
          const codes = [...preview.blockers.map(row => String(row.code || "").trim() || "UNCLASSIFIED_BLOCKER"),
            ...anomalies.map(row => String(row.error || "").trim() || "PROTECTED_OR_UNCLASSIFIED_PATH")];
          const busy = preview.blockers.filter(row => row.busy).map(row => Object.assign({ nodeId: row.nodeId }, row.busy));
          blocked.push({ index: Number(job.index), reason, codes, busyOnly: busyOnlyEvidence(codes), busy, stage: "preview", code: codes[0] });
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
          codes: [code || "UNCLASSIFIED_PREVIEW_ERROR"], busyOnly: code === TRANSFER_BUSY_CODE, busy: thrownBusy,
          stage: "preview", code: code || "UNCLASSIFIED_PREVIEW_ERROR" });
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
  // 对话道回调里 TS 收窄失效；本行起 state.previews 恒存在（上方分支已保证），用别名传递同一引用。
  const previewRows = state.previews;
  if (ports.prepareEmptyParents && !state.emptyParents && !state.done) {
    // Recovered old confirmations did not show these additional paths. Ask both pages afresh.
    if (state.choice && targets(previewRows).length) { delete state.choice; delete state.selectedIndices; state.phase = 0; }
    const prepared: Record<string, EmptyParentPreview[]> = {};
    for (const { preview } of previewRows) if (targets([{ index: 0, preview }]).length)
      prepared[preview.token] = await ports.prepareEmptyParents(preview);
    state.emptyParents = prepared; await ports.save();
  }
  const permanentTargets = (rows: typeof previewRows) => rows.flatMap(({ preview }) => (state.emptyParents?.[preview.token] || []).flatMap(group =>
    group.confirmationTargets.map(target => ({ server: group.node.id, connection: group.node.kind === "remote"
      ? group.node.user + "@" + group.node.host + ":" + group.node.port : "本机", path: target.absolutePath, type: target.type }))));
  if (!state.choice) await gate(async () => {
    ports.progress("等待选择运行范围并核对将移入隔离区的完整路径…");
    const choice = await ports.ask({ phase: 1, planFile, title: "选择运行范围并核对将移入 clean 隔离区的完整路径", groups: [
      { value: "rerun_all", label: "覆盖并重跑全部（永久删除隔离旧产物及所列空目录）", targets: [...targets(previewRows), ...permanentTargets(previewRows)] },
      { value: "rerun_missing", label: "仅补跑未完成任务", disabled: !missing.length,
        targets: targets(previewRows.filter(row => missing.includes(row.index))) }] });
    if (!["rerun_all", "rerun_missing"].includes(choice)) cleanupError("REPLACEMENT_CANCELLED", "已取消；未移动文件或提交任务。");
    if (choice === "rerun_all" && ports.confirmEmptyParents)
      await ports.confirmEmptyParents(previewRows.flatMap(({ preview }) => state.emptyParents?.[preview.token] || []), 1);
    state.choice = choice as RunReplacement["choice"];
    state.selectedIndices = choice === "rerun_missing" ? missing : all;
    await ports.save();
  });
  state.selectedIndices ||= state.choice === "rerun_missing" ? missing : all;
  const selected = state.previews.filter(row => state.selectedIndices!.includes(row.index) && targets([row]).length);
  const exact = targets(selected);
  const permanent = state.choice === "rerun_all" ? permanentTargets(selected) : [];
  if (exact.length && (state.phase || 0) < 1) await gate(async () => {
    ports.progress(permanent.length ? "等待第二次确认永久删除隔离旧产物及所列空目录；新运行在隔离后启动…"
      : "等待确认：旧输出移入 clean 隔离区后立即启动新运行；永久删除稍后单独双确认…");
    if (await ports.ask({ phase: 2, planFile, title: "将以下旧输出移入 clean 隔离区并重跑", groups: [
      { value: "isolate_and_run", label: permanent.length ? "确认永久删除隔离旧产物与所列空目录，并重跑"
        : "隔离并重跑（旧输出不直接删除；永久删除稍后单独两次确认）", targets: [...exact, ...permanent] }] }) !== "isolate_and_run")
      cleanupError("REPLACEMENT_CANCELLED", "已取消；未移动文件或提交任务。");
    if (permanent.length && ports.confirmEmptyParents)
      await ports.confirmEmptyParents(selected.flatMap(({ preview }) => state.emptyParents?.[preview.token] || []), 2);
    for (const { preview } of selected) await ports.service.confirm({ token: preview.token, digest: preview.digest, phase: 1, confirm: true,
      exactTargets: targets([{ index: 0, preview }]).map(row => row.server + ":" + row.path) });
    state.phase = 1; await ports.save();
  });
  ports.assertCurrent();
  if (selected.length) {
    // beforeDelete（worker 准备/身份/源指纹/精确路径复核）无 SFTP 计忙证据，保持在写临界段之外。
    // 写段粒度（r74 父裁定）：保留"全部 confirmed 目标先 preflight 再移动"的既有安全顺序，前置预检
    // 独占一个必要写段；此后每个 token 各占一次必要写段（execute→必要 status 兜底 / verify），相邻
    // token 之间允许已排队的读者按 FIFO 前进。SFTP 每次 execute 仍自核最新身份/hash，跨段不削弱保护；
    // 本地回执 save 与失败明细登记都在段外，绝不持写锁跨与当前资源无关的等待。
    await ports.beforeDelete();
    await lane("write", async () => { for (const { preview } of selected) await ports.service.preflightConfirmed(preview.token); });
    state.completed ||= []; state.blocked ||= [];
    for (const { index, preview } of selected) {
      ports.assertCurrent();
      if (blockedIndexes.has(index)) continue;
      if (state.completed.includes(preview.token)) {
        // 已完成记录的复核：status 非 observer 计忙，与 verify 同段；失败明细登记落盘在段外。
        let recheckFailure: unknown; let recheckFailed = false;
        await lane("write", async () => {
          try {
            const persisted = await ports.service.status(preview.token);
            if (persisted.state !== "completed") throw new Error("已记录的隔离批次未确认完成");
            // r87 块4：0.2.111 完成回执（rename 成功、移动当时源缺失、登记成功，已随操作冻结落盘）
            // 即为移动阶段本节点事实的完备证明，回执齐备不再逐条复核原路径；
            // 能力缺失或回执不全时走旧 verify 链，强度不变。
            if (!(Number(persisted.preview?.autoDeleteCapability) === 1 && isolationReceiptComplete(persisted.preview.rows)))
              await ports.verify(preview);
          } catch (error) { recheckFailed = true; recheckFailure = error; }
        });
        if (recheckFailed) { blockedIndexes.add(index); state.blocked.push({ index, reason: String((recheckFailure as any)?.message || recheckFailure), stage: "verify" }); await ports.save(); }
        continue;
      }
      ports.progress("正在把已确认旧输出移入 clean 隔离区；已完成 " + state.completed.length + "/" + selected.length + " 批…");
      let moved = false; let blockReason = ""; let blockCode = "";
      // r88：execute 返回的操作快照（能力位+随行回执）在写段回调之外才使用——提升为显式变量、
      // 回调内赋值；不改 any/断言，也不事后重查插件（"随行冻结"语义保持）。
      let executePreview: CleanupPreview | undefined;
      await lane("write", async () => {
        let result;
        try { result = await ports.execute(preview.token); }
        catch (error) {
          // r82：执行拒绝的精确错误码（如 PREVIEW_EXPIRED）必须留在阻断事实里——现场靠它区分
          // "令牌过期须重新预览"与普通冲突；状态兜底只补"是否已动手"的证据，不洗掉错误码。
          blockCode = String((error as any)?.apiData?.code || (error as any)?.code || "");
          try { result = await ports.service.status(preview.token); } catch {}
          if (result?.state !== "completed") { blockReason = String((error as any)?.message || error); return; }
        }
        // r82 现场修复：顶层 completed 与空 pendingNodes 都不是准入证明——批次返回逐 target 明细时
        // 必须逐条核对，任一 target 非 completed（pending/executing/未知）一律不准入（r81a：四 target 全
        // pending 却"顶层好看"）。无明细保持既有保守判断，不放低标准。
        const targetRows = Array.isArray(result?.targets) ? result.targets : Object.values(result?.targets || {});
        const targetPending = targetRows.some((row: any) => row && typeof row === "object" && row.state !== "completed");
        if (result.state !== "completed" || result.pendingNodes?.length || targetPending) { blockReason = String(result.error || "部分目标尚未确认隔离完成，可重试失败步骤"); return; }
        moved = true;
        executePreview = result?.preview;
      });
      if (!moved) { blockedIndexes.add(index); state.blocked.push({ index, reason: blockReason, stage: "execute", ...(blockCode ? { code: blockCode } : {}) }); await ports.save(); continue; }
      state.completed.push(preview.token); await ports.save(); // 完成事实先落盘（verify 之前），落盘等待不持写锁——与原顺序一致
      let verifyFailed = false; let verifyReason = "";
      // r87 块4：receipt-backed = 该预览的插件应答声明后台清理能力，且每个 isolate 目标都返回完整完成回执
      // （rename 成功、移动当时源缺失、登记成功——execute 返回随操作冻结落盘）。
      // 回执齐备→跳过原路径复核（不再"读隔离副本/重查源"后才派发）；有能力而回执不全→该 job 按未核实阻断、不派发；
      // 能力缺失→旧 verify 链原样保留，不削弱也不加强度。
      const capability = Number(executePreview?.autoDeleteCapability) === 1;
      const receiptBacked = executePreview !== undefined && capability && isolationReceiptComplete(executePreview.rows);
      if (capability && !receiptBacked) { verifyFailed = true; verifyReason = "隔离完成回执不完整（rename/移动当时源缺失/登记未全部成功返回），未准入该 job，未提交任务。"; }
      else if (!receiptBacked)
        await lane("write", async () => { try { await ports.verify(preview); } catch (error: any) { verifyFailed = true; verifyReason = String(error?.message || error); } });
      if (verifyFailed) { blockedIndexes.add(index); state.blocked.push({ index, reason: verifyReason, stage: "verify" }); await ports.save(); continue; }
      // 隔离完成即派发：后台删除是旁路任务，不进本 await 链；仅本轮用户选择 rerun_all 时触发。
      // autoDeleteIsolated 为 async 方法且传输异常自落 unknown，不会抛回；这里仍只落日志/通知——
      // 不回滚隔离、不取消已派发 job、不把新 job 判失败；受理/未成功措辞与实际状态逐字一致，
      // accepted 只说"已提交后台永久删除"，绝不写成"删除已完成"。
      if (receiptBacked && state.choice === "rerun_all" && ports.autoDeleteIsolated) {
        const isolateTargets = preview.rows.filter(row => row.disposition === "isolate").map(row => row.node.id + "：" + row.destination).join("、");
        void ports.autoDeleteIsolated(preview.token, state.emptyParents?.[preview.token]).then(outcome => {
          if (outcome.state === "accepted")
            ports.progress("旧副本已提交后台永久删除（自动删除不可恢复）：" + isolateTargets + "；不影响已经启动的新任务。");
          else ports.progress("旧副本后台清理未成功（job " + index + "，" + isolateTargets + "，状态 " + outcome.state
            + (outcome.operationId ? "，维护号 " + outcome.operationId : "") + "，不影响已启动的新任务）：" + (outcome.message || "未返回原因")
            + "；副本仍在清理区，可稍后人工复核删除。");
        }, (error: any) => ports.progress("旧副本后台清理未受理（job " + index + "，" + isolateTargets + "，不影响已启动的新任务）："
          + String(error?.message || error)));
      }
    }
    // r87 块4 兼容矩阵行1：旧插件（未上报能力）→ 保留旧链、不调新接口、不自动删，并明确提示需更新。
    if (state.choice === "rerun_all" && selected.some(({ preview }) => Number(preview.autoDeleteCapability) !== 1))
      ports.progress("旧产物已隔离、新任务不受影响，但配套 SimpleSFTP 未上报后台自动清理能力：旧副本不会自动删除；自动清理需更新 SimpleSFTP 到 0.2.111。");
  }
  const accepted = (state.selectedIndices || []).filter(index => !blockedIndexes.has(index));
  if (jobs.length && !accepted.length)
    cleanupError("OUTPUT_ISOLATION_FAILED", (state.blocked || []).map(row => "job " + row.index + "：" + row.reason).join("\n")
      + "\n没有任何 job 通过隔离准入；旧输出仅移入 clean 区，未提交任务。");
  // 与旧删除流一致：仅当本轮确有旧输出被隔离时才对已准入 job 建立保留围栏；空产物提交不动队列。
  if (selected.length) await ports.hold(jobs.filter(job => accepted.includes(Number(job.index))));
  state.done = true; delete state.emptyParents; await ports.save();
  // r82：准入决定结构化交回调用方——selectedIndices（运行选择里最终准入者）与 blocked（隔离未完成/
  // 核验未知者）成对返回，与"用户有意跳过"互斥；成功轮次也必须显式返回 blocked=[]，
  // 下游不得把缺字段当"无阻断"或"全放行"。
  const blockedFacts: RunReplacementBlockedFact[] = (state.blocked || []).filter(row => blockedIndexes.has(Number(row.index)))
    .map(row => ({ index: Number(row.index), reason: row.reason, stage: row.stage || "verify" as const, ...(row.code ? { code: row.code } : {}),
      ...(row.codes ? {codes:row.codes} : {}), ...(typeof row.busyOnly === "boolean" ? {busyOnly:row.busyOnly} : {}), ...(row.operationId ? {operationId:row.operationId} : {}) }));
  return { choice: state.choice!, selectedIndices: accepted, blocked: blockedFacts };
}

export const runReplacementKey = (plan: string, revision: string, code: string, jobs: any[], nodes: any[]) =>
  cleanupDigest([plan, revision, code, jobs, nodes]);
