import * as path from "node:path";
import { cleanupDigest, cleanupError, cleanupRelative, type CleanupNode, type CleanupPorts, type CleanupPreview } from "./PlanCleanup";

export type EmptyParentPreview = { token: string; digest: string; node: CleanupNode; sourceIsolationTokens: string[];
  confirmationPaths: string[]; confirmations: number; targets: Array<{ absolutePath: string; type: "directory" }>;
  confirmationTargets: Array<{ absolutePath: string; type: "file" | "directory" }> };
type Ports = Pick<CleanupPorts, "sftp" | "currentNode">;
async function current(ports: Ports, node: CleanupNode) {
  if (ports.currentNode && cleanupDigest({ ...await ports.currentNode(node.id), error: undefined }) !== cleanupDigest({ ...node, error: undefined }))
    cleanupError("SERVER_IDENTITY_CHANGED");
}
export async function previewEmptyParents(ports: Ports, preview: CleanupPreview, forReplacement: boolean): Promise<EmptyParentPreview[]> {
  if (preview.action !== "isolate") cleanupError("NOT_ISOLATED_OPERATION");
  const groups = new Map<string, typeof preview.rows>();
  for (const row of preview.rows.filter(row => row.disposition === "isolate")) {
    if (!row.backendToken || !row.rootIdentity || !/^clean_dir\/job-[a-f0-9]{48}\//.test(row.destination)) cleanupError("INVALID_ISOLATION_BINDING");
    const key = cleanupDigest([row.node, row.destination.split("/")[1]]);
    const group = groups.get(key); if (group) group.push(row); else groups.set(key, [row]);
  }
  const result: EmptyParentPreview[] = [];
  for (const rows of groups.values()) {
    const node = rows[0].node; await current(ports, node);
    const sourceIsolationTokens = [...new Set(rows.map(row => row.backendToken!))];
    const answer = await ports.sftp("files.cleanup.isolationParentsPreview", { isolationTokens: sourceIsolationTokens, forReplacement });
    if (answer?.eligible === false) continue;
    const allowed = new Set<string>();
    const absolute = (relative: string) => node.kind === "local" ? path.join(node.root, relative) : path.posix.join(node.root, relative);
    for (const row of rows) {
      const parts = cleanupRelative(row.destination).split("/"); parts.pop();
      while (parts.length >= 2) { allowed.add(absolute(parts.join("/"))); parts.pop(); }
    }
    const parents = Array.isArray(answer?.targets) ? answer.targets : [];
    const expected = [...parents.map((row: any) => row.absolutePath), ...(forReplacement ? [...new Set(rows.map(row => absolute(row.destination)))] : [])];
    if (answer?.isolationParentCleanup !== true || answer?.safety?.emptyDirectoriesOnly !== 1 || answer?.safety?.doubleConfirmation !== 1
        || answer?.safety?.parentCwdRequired !== 1 || cleanupDigest(answer.rootIdentity) !== cleanupDigest(rows[0].rootIdentity)
        || cleanupDigest(answer.sourceIsolationTokens) !== cleanupDigest(sourceIsolationTokens)
        || typeof answer.token !== "string" || typeof answer.digest !== "string" || !Array.isArray(answer.targets) || (!parents.length && !forReplacement)
        || parents.some((row: any) => row.type !== "directory" || !allowed.has(row.absolutePath))
        || new Set(parents.map((row: any) => row.absolutePath)).size !== parents.length
        || cleanupDigest(answer.confirmationPaths) !== cleanupDigest(expected)) cleanupError("SFTP_EMPTY_PARENT_PROTOCOL_REQUIRED", "空目录清理需要 SimpleSFTP 0.2.116 的精确路径双确认协议；未执行删除。");
    result.push({ token: answer.token, digest: answer.digest, node, sourceIsolationTokens, confirmationPaths: expected,
      confirmations: 0, targets: parents.map((row: any) => ({ absolutePath: row.absolutePath, type: "directory" })),
      confirmationTargets: expected.map(absolutePath => ({ absolutePath,
        type: allowed.has(absolutePath) ? "directory" : rows.find(row => absolute(row.destination) === absolutePath)!.type })) });
  }
  return result;
}
export async function confirmEmptyParents(ports: Ports, previews: EmptyParentPreview[], phase: number): Promise<void> {
  for (const row of previews) {
    await current(ports, row.node);
    if (row.confirmations === phase) continue;
    await ports.sftp("files.cleanup.confirm", { token: row.token, digest: row.digest, phase, confirm: true, exactTargets: row.confirmationPaths });
    row.confirmations = phase;
  }
}
export async function executeEmptyParents(ports: Ports, previews: EmptyParentPreview[]): Promise<number> {
  let removed = 0;
  for (const row of previews) {
    await current(ports, row.node);
    if (row.confirmations !== 2) cleanupError("CONFIRM_REQUIRED");
    const result = await ports.sftp("files.cleanup.execute", { token: row.token, digest: row.digest, index: 0 });
    if (result?.state !== "completed") cleanupError("EMPTY_PARENT_CLEANUP_UNVERIFIED");
    removed += Number(result.receipt?.emptyDirectoriesRemoved || 0);
  }
  return removed;
}
