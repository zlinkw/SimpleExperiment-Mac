// SimpleSFTP 清理协议应答安全守卫（2026-10-23 行数门禁返修：从 PlanCleanupHost 构造函数
// sftp 闭包逐行原样提取；每条应答门禁、升级错误与零确认零执行语义保持原样）。
import { cleanupError } from "../features/PlanCleanup";
import { assertFastDeletePreviewSafety, fastDeleteUpgradeError, isFastDeleteUpgradeCode } from "../features/FastDeleteContract";

/** r17-D consumerRoot: 每个 files.cleanup.* 请求都携带本主机的冻结消费项目绝对 root（令牌台账的
 * 归属就写在这个项目内）。remote 的 node.root 绝不参与归属；调用方传入的同名字段一律被冻结 root
 * 覆盖——服务端只认这份原主会话上下文携带的身份，缺它后端会明确拒绝而不是猜 cwd。 */
export async function guardCleanupSftpCall(host: any, consumerRoot: string, method: string, params: any): Promise<any> {
  if (typeof method === "string" && method.startsWith("files.cleanup.")) {
    if (!consumerRoot) cleanupError("WORKSPACE_CHANGED", "消费项目根未冻结，未发送任何清理请求。");
    params = { ...params, consumerRoot };
  }
  let result: any;
  try { result = await host.simpleSftpApiCall(method, params); }
  catch (error: any) {
    // 旧引擎以 UNKNOWN_ACTION / UPDATE_REQUIRED 拒绝确认快速链时：统一"需要更新"错误，零确认零执行。
    if (method === "files.cleanup.preview" && params.authorizationMode === "confirmed_paths" && params.action === "delete"
      && isFastDeleteUpgradeCode(error?.apiData?.code ?? error?.code)) fastDeleteUpgradeError();
    throw error;
  }
  if (method === "files.cleanup.preview" && params.authorizationMode === "confirmed_paths" && params.action === "delete") {
    // v1.9：确认路径快速链以其应答的快标志块为唯一契约；旧通用链门禁（managedObservation、
    // Git 祖先预检、归档批次、正式 job 属主）属于已退役链路，快速路径不再套用。
    assertFastDeletePreviewSafety(result?.safety, Array.isArray(params.targets) ? params.targets.length : 0);
    return result;
  }
  if (method === "files.cleanup.preview" && params.observationMode === "managed_tmux" && result.safety?.managedObservation !== 1)
    cleanupError("SFTP_MANAGED_OBSERVATION_REQUIRED", "请更新配套 SimpleSFTP；尚未执行清理。");
  if (method === "files.cleanup.preview" && (result.safety?.gitRepositoryAncestors !== true || result.safety?.readOnlyReceiptCheck !== true))
    cleanupError("SFTP_SAFE_CLEANUP_UPGRADE_REQUIRED", "当前 SimpleSFTP 缺少 Git 祖先仓库预检或只读回执核查；请更新配套插件后重新预览。");
  if (method === "files.cleanup.preview" && params.targets?.some((target: any) => target.expectedOwner?.resultPathPolicy === "declared") && result.safety?.formalJobOwner !== true)
    cleanupError("SFTP_FORMAL_OWNER_UPGRADE_REQUIRED", "需要支持正式 job 身份核验的 SimpleSFTP，尚未执行任何清理。");
  if (method === "files.cleanup.preview" && params.targets?.some((target: any) => target.archiveBatch) && result.safety?.immutableArchiveBatch !== true)
    cleanupError("SFTP_ARCHIVE_BATCH_UPGRADE_REQUIRED", "需要支持预先确定的归档批次布局的 SimpleSFTP，尚未执行任何清理。");
  if (method === "files.cleanup.preview" && params.targets?.some((target: any) => target.expectedOwner?.expectedState === "completed")
    && !(Number(result.safety?.batchPreviewCapacity) >= 4096))
    cleanupError("SFTP_BATCH_PREVIEW_UPGRADE_REQUIRED", "需要 SimpleSFTP 0.2.79 的批次预览保留能力，未执行清理。");
  return result;
}
