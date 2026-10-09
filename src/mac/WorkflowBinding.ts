import * as fs from "node:fs";
import { normalizePosixAbsolutePath } from "./PosixPath";

export interface WorkspaceIdentity { canonical: string; device: number; inode: number }
export interface WorkflowBinding { root: string; identity: WorkspaceIdentity }
type Probe = (root: string) => WorkspaceIdentity;

function probeWorkspace(root: string): WorkspaceIdentity {
  const canonical = fs.realpathSync(root);
  const stat = fs.statSync(canonical);
  if (!stat.isDirectory()) throw new Error("Mac workflow 工作区必须是现有目录。");
  return { canonical, device: stat.dev, inode: stat.ino };
}

function sameIdentity(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return a.canonical === b.canonical && a.device === b.device && a.inode === b.inode;
}

export function assertPlanSeedContract(params: Record<string, unknown>): void {
  if (params.seed !== undefined) throw new Error("workflow 不支持 seed 覆盖；请在已保存的 Plan 中配置 seeds，移除 CLI --seed 后重新预检。");
}

export function bindWorkflowWorkspace(requested: unknown, current: unknown, probe: Probe = probeWorkspace): WorkflowBinding {
  const root = normalizePosixAbsolutePath(current, "当前 Mac 工作区");
  const target = requested === undefined ? root : normalizePosixAbsolutePath(requested, "workflow workspace");
  const identity = probe(root);
  if (!sameIdentity(identity, probe(target))) throw new Error("Mac workflow workspace 必须是当前打开的本机项目；未执行准备或提交。");
  return { root, identity };
}

export function assertWorkflowWorkspace(binding: WorkflowBinding, current: unknown, probe: Probe = probeWorkspace): void {
  const root = normalizePosixAbsolutePath(current, "当前 Mac 工作区");
  if (!sameIdentity(binding.identity, probe(root)) || !sameIdentity(binding.identity, probe(binding.root))) {
    throw new Error("Mac workflow 工作区或目录身份已变化；未继续准备、停止或提交实验。");
  }
}
