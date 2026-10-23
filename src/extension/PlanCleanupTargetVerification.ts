// 单 job「删除并重新排队」的逐目标不存在核验（2026-10-23 行数门禁返修：从
// PlanCleanupHost.verifyDeclaredTargets 逐行原样提取的独立职责模块）。
// 返修（2026-10-21）P0 语义原样保留：缺失的声明目录不会进候选（ManifestCleanup 只报告存在的产物）——
// 「候选缺失」不等于「已删除」。本模块是唯一被允许的 absence 证据来源：对原预览冻结的物理节点集合 ×
// 完整声明路径逐一 files.cleanup.inspect（只读），节点身份必须先与当前配置一致（endpoint/安全根漂移即
// error）；后端必须回 target.missing===true 才算 absent；任何异常/含糊应答都是 error，绝不推断不存在。
// 它不产生删除候选、不改变审核范围，也不替代预览。
import { cleanupDigest } from "../features/PlanCleanup";

export interface TargetVerificationContext {
  host: any;
  assertWorkspace(): void;
  currentNode(id: string): any;
}

export async function verifyDeclaredTargetsOnNodes(ctx: TargetVerificationContext, params: {
  declared: Array<{ relativePath: string; type: string }>; nodes: any[] }) {
  ctx.assertWorkspace();
  const verdicts: Array<{ nodeId: string; relativePath: string; type: string; state: "absent" | "present" | "error"; rootIdentity?: unknown; error?: string }> = [];
  const blockers: Array<{ code: string; nodeId: string; detail: string }> = [];
  for (const frozen of params.nodes) {
    if (frozen.error) { blockers.push({ code: "OFFLINE_NODE", nodeId: String(frozen.id), detail: String(frozen.error) }); continue; }
    let live: any;
    try { live = ctx.currentNode(String(frozen.id)); }
    catch (error: any) { blockers.push({ code: "SERVER_IDENTITY_UNVERIFIED", nodeId: String(frozen.id), detail: String(error?.message || error) }); continue; }
    if (cleanupDigest({ ...live, error: undefined }) !== cleanupDigest({ ...frozen, error: undefined }))
      blockers.push({ code: "SERVER_IDENTITY_CHANGED", nodeId: String(frozen.id), detail: "节点身份或安全根与预览时不一致；重新预览前不作任何存在性结论" });
    for (const target of params.declared) {
      if (frozen.error || blockers.some(row => row.nodeId === String(frozen.id))) continue;
      try {
        const info: any = await ctx.host.simpleSftpApiCall("files.cleanup.inspect", { node: live,
          target: { relativePath: target.relativePath, type: target.type }, allowMissing: true, manifestOnly: true, presenceOnly: true });
        if (info?.target?.missing === true) verdicts.push({ nodeId: live.id, relativePath: target.relativePath, type: target.type, state: "absent", rootIdentity: info.rootIdentity });
        else if (info?.target && (info.target.missing === false || typeof info.target.absolutePath === "string")) verdicts.push({ nodeId: live.id, relativePath: target.relativePath, type: target.type, state: "present", rootIdentity: info.rootIdentity });
        else verdicts.push({ nodeId: live.id, relativePath: target.relativePath, type: target.type, state: "error", error: "UNVERIFIED_RESPONSE" });
      } catch (error: any) {
        verdicts.push({ nodeId: live.id, relativePath: target.relativePath, type: target.type, state: "error", error: String(error?.message || error) });
      }
    }
  }
  return { verdicts, blockers };
}
