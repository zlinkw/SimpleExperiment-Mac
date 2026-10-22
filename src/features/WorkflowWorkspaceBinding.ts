import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePosixAbsolutePath } from "../mac/PosixPath";

export interface WorkspaceIdentity { canonical: string; device: string; inode: string }
export interface WorkflowBinding { root: string; identity: WorkspaceIdentity }
type Probe = (root: string) => WorkspaceIdentity;
function absolute(value: unknown): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) throw new Error("workflow 工作区必须是已打开的绝对目录。");
  // Platform overlay: non-Windows hosts keep the strict POSIX identity contract
  // (no root, no . or .. segments, no backslashes, spelling and leaf spaces preserved);
  // the Windows branch stays byte-identical to the frozen 0.5.400 behavior.
  if (process.platform !== "win32") return normalizePosixAbsolutePath(value, "workflow 工作区");
  return value;
}
const key = (value: string) => process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
export function probeWorkspace(root: string): WorkspaceIdentity {
  const canonical = fs.realpathSync.native(root), stat = fs.statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new Error("workflow 工作区必须是现有目录。");
  return { canonical: key(canonical), device: stat.dev.toString(), inode: stat.ino.toString() };
}
function same(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean { return key(a.canonical) === key(b.canonical) && a.device === b.device && a.inode === b.inode; }
export function assertPlanSeedContract(params: Record<string, unknown>): void {
  if (params.seed !== undefined) throw new Error("workflow 不支持 seed 覆盖；请在保存的 PLAN 中配置 seeds，移除 --seed 后重新预检。");
}
export function bindWorkflowWorkspace(requested: unknown, current: unknown, probe: Probe = probeWorkspace): WorkflowBinding {
  const root = absolute(current), target = requested === undefined ? root : absolute(requested), identity = probe(root);
  if (!same(identity, probe(target))) throw new Error("workflow workspace 必须是当前打开的项目；未执行准备或提交。");
  return { root, identity };
}
export function assertWorkflowWorkspace(binding: WorkflowBinding, current: unknown, probe: Probe = probeWorkspace): void {
  if (!same(binding.identity, probe(absolute(current))) || !same(binding.identity, probe(binding.root))) throw new Error("workflow 工作区或目录身份已变化，未继续准备或提交。");
}

/** Cheap async-boundary guard; the native directory check remains at entry and before writes. */
export function assertWorkflowContext(binding: WorkflowBinding, current: unknown, currentGeneration: unknown, expectedGeneration: unknown): void {
  if (currentGeneration !== expectedGeneration || key(absolute(current)) !== key(binding.root))
    throw new Error("workflow 工作区已变化，未继续准备或提交。");
}
