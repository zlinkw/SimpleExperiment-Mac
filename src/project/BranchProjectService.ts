/**
 * src/project/BranchProjectService.ts - verification/registration orchestration for the ancestor +
 * innovation-branch registry (block A). Pure Node: the extension host supplies the dialogs and the
 * user's preview confirmations; this service re-checks reality on every mutation and refuses when
 * the recorded identity drifted, the directory got dirty/diverged for a stop-required operation, or
 * the exact target already exists. It never resets, rebases, stashes, force-updates or deletes.
 *
 * It also exposes the narrow read projections block B/C will consume: registered roots, branch
 * identity with live git state, and (via LocalApiClient instances discovery) live windows per root.
 */
import * as fs from "fs";
import * as path from "path";
import {
  AncestorProjectRecord,
  BranchProjectFile,
  BranchProjectRecord,
  BranchProjectStore,
  branchProjectFileDigest,
  canonicalComparablePath,
  createBranchPreviewDigest,
  newRecordId,
  sameComparablePath,
} from "./BranchProjectStore";
import {
  AncestorRelation,
  GitIdentity,
  checkBranchNameFree,
  compareAncestorRelation,
  createWorktreeBranch,
  listWorktrees,
  readGitIdentity,
} from "./GitIdentityProbe";

export interface AncestorVerification {
  record: AncestorProjectRecord;
  /** Live git read at verification time; toplevel "" means unavailable right now. */
  git: { toplevel: string; commonDir: string; branch: string; detached: boolean; headCommit: string; dirty: boolean; remotes: Array<{ name: string; url: string }> };
  /** "verified" | "missing" | "not-a-repository" | "identity-drift" | "dirty" | "detached" | "error". */
  state: string;
  /** Target branch drifted away or HEAD moved off the recorded branch/detached. */
  errors: string[];
  verifiedAt: string;
}

export interface BranchVerification {
  record: BranchProjectRecord;
  git: { toplevel: string; commonDir: string; branch: string; detached: boolean; headCommit: string; dirty: boolean; remotes: Array<{ name: string; url: string }> };
  /** "verified" | "missing" | "not-a-repository" | "identity-drift" | "detached" | "error". */
  state: string;
  relation: AncestorRelation;
  /** Honest verification posture: research validation is a separate pipeline; this only proves git identity. */
  researchValidated: false;
  errors: string[];
  verifiedAt: string;
}

export interface RegistryProjection {
  /** Current window's workspace root (what this extension host is bound to), for card routing. */
  currentWorkspaceRoot: string;
  fileDigest: string;
  storagePath: string;
  ancestors: AncestorVerification[];
  branches: BranchVerification[];
  verifiedAt: string;
}

export interface CreateBranchPreview {
  digest: string;
  ancestorLabel: string;
  ancestorRoot: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  targetPath: string;
  warnings: string[];
}

export interface CreateBranchRequest {
  ancestorId: string;
  branch: string;
  targetParentDir: string;
  confirmDigest: string;
}

export interface CreateBranchResult {
  ok: boolean;
  message: string;
  record?: BranchProjectRecord;
}

function nowIso(): string { return new Date().toISOString(); }

function gitSnapshot(identity: GitIdentity) {
  return { toplevel: identity.toplevel, commonDir: identity.commonDir, branch: identity.branch, detached: identity.detached, headCommit: identity.headCommit, dirty: identity.dirty, remotes: identity.remotes };
}

export class BranchProjectService {
  private readonly store: BranchProjectStore;
  private readonly currentWorkspaceRootProvider: () => string;

  constructor(store: BranchProjectStore, currentWorkspaceRootProvider: () => string) {
    this.store = store;
    this.currentWorkspaceRootProvider = currentWorkspaceRootProvider;
  }

  get storagePath(): string { return this.store.filePath; }

  fileDigest(): string { return branchProjectFileDigest(this.store.load()); }

  /**
   * Lightweight registered-roots list (no git probing) for the unified dispatch domain check and
   * member queue reads; roots keep the recorded casing so per-project queue paths derive exactly.
   */
  registryInventory(): { ancestors: string[]; branches: string[] } {
    const file = this.store.load();
    return { ancestors: file.ancestors.map((row) => row.gitRoot), branches: file.branches.map((row) => row.workspaceRoot) };
  }

  /** Read-only verification of every registered record. Never writes to any registered directory. */
  verifyAll(): RegistryProjection {
    const file = this.store.load();
    const verifiedAt = nowIso();
    const ancestors: AncestorVerification[] = [];
    const ancestorById = new Map<string, AncestorProjectRecord>();
    for (const record of file.ancestors) {
      ancestorById.set(record.id, record);
      ancestors.push(this.verifyAncestor(record, verifiedAt));
    }
    const branches: BranchVerification[] = [];
    for (const record of file.branches) {
      const ancestor = ancestorById.get(record.ancestorId);
      branches.push(this.verifyBranch(record, ancestor, verifiedAt));
    }
    return {
      currentWorkspaceRoot: String(this.currentWorkspaceRootProvider() || ""),
      fileDigest: branchProjectFileDigest(file),
      storagePath: this.store.filePath,
      ancestors,
      branches,
      verifiedAt,
    };
  }

  private verifyAncestor(record: AncestorProjectRecord, verifiedAt: string): AncestorVerification {
    const base: AncestorVerification = { record, git: gitSnapshot({ toplevel: "", commonDir: "", notARepository: false, branch: "", detached: false, headCommit: "", dirty: false, remotes: [], error: "" } as GitIdentity), state: "error", errors: [], verifiedAt };
    if (!fs.existsSync(record.gitRoot)) { base.state = "missing"; base.errors.push("登记的祖先目录不存在。"); return base; }
    const identity = readGitIdentity(record.gitRoot);
    base.git = gitSnapshot(identity);
    if (!identity.toplevel) { base.state = identity.notARepository ? "not-a-repository" : "error"; base.errors.push(identity.error || "无法读取 Git 身份。"); return base; }
    // A fatal probe step (common-dir/status) after a successful toplevel still carries identity.error;
    // dirty=false then only means "unreadable", never "clean". Such a repository is never verified.
    if (identity.error) { base.state = "error"; base.errors.push(`Git 状态读取失败，身份与干净状态未核实：${identity.error}`); return base; }
    if (!sameComparablePath(identity.toplevel, record.gitRoot)) { base.state = "identity-drift"; base.errors.push(`目录实际 Git 根为 ${identity.toplevel}，与登记不一致。`); return base; }
    if (identity.detached) { base.state = "detached"; base.errors.push("祖先当前处于 detached HEAD；请在干净分支状态下继续。"); return base; }
    if (identity.branch !== record.targetBranch) { base.state = "identity-drift"; base.errors.push(`当前分支 ${identity.branch || "?"} 与登记目标分支 ${record.targetBranch} 不一致。`); return base; }
    if (identity.dirty) { base.state = "dirty"; base.errors.push("祖先工作区存在未提交修改；分支管理仍可读取，但创建/合并确认前必须先处理。"); return base; }
    base.state = "verified";
    return base;
  }

  private verifyBranch(record: BranchProjectRecord, ancestor: AncestorProjectRecord | undefined, verifiedAt: string): BranchVerification {
    const emptyGit = gitSnapshot({ toplevel: "", commonDir: "", notARepository: false, branch: "", detached: false, headCommit: "", dirty: false, remotes: [], error: "" } as GitIdentity);
    const base: BranchVerification = { record, git: emptyGit, state: "error", relation: "unavailable", researchValidated: false, errors: [], verifiedAt };
    if (!fs.existsSync(record.workspaceRoot)) { base.state = "missing"; base.errors.push("登记的分支副本目录不存在。"); return base; }
    const identity = readGitIdentity(record.workspaceRoot);
    base.git = gitSnapshot(identity);
    if (!identity.toplevel) { base.state = identity.notARepository ? "not-a-repository" : "error"; base.errors.push(identity.error || "无法读取 Git 身份。"); return base; }
    // Same rule as ancestors: a failed status/common-dir read is never presented as verified-clean.
    if (identity.error) { base.state = "error"; base.errors.push(`Git 状态读取失败，身份与干净状态未核实：${identity.error}`); return base; }
    if (!sameComparablePath(identity.toplevel, record.workspaceRoot)) { base.state = "identity-drift"; base.errors.push(`目录实际 Git 根为 ${identity.toplevel}，与登记不一致。`); return base; }
    if (identity.detached) { base.state = "detached"; base.errors.push("分支副本当前处于 detached HEAD。"); return base; }
    if (identity.branch !== record.branch) { base.state = "identity-drift"; base.errors.push(`当前分支 ${identity.branch || "?"} 与登记分支 ${record.branch} 不一致。`); return base; }
    if (ancestor) {
      const ancestorIdentity = readGitIdentity(ancestor.gitRoot);
      base.relation = compareAncestorRelation(ancestorIdentity, identity);
    }
    base.state = "verified";
    if (identity.dirty) base.errors.push("分支副本存在未提交修改（照常显示，不影响读取）。准备提示：本机运行状态 simple_cluster/state/（本扩展的队列/状态目录）也会让 Git 报未跟踪——请先用本机 Git 排除规则排除该状态目录再提交科研代码；该目录可能含科研源码，请勿忽略整个 simple_cluster/，本插件不代改 Git 配置，这些状态文件也不应提交。");
    return base;
  }

  /** Registers an existing directory as the ancestor project after the caller's user confirmation. */
  async registerAncestor(input: { label: string; gitRoot: string; remoteName?: string; remoteUrl?: string }): Promise<AncestorProjectRecord> {
    const gitRoot = path.normalize(String(input.gitRoot || ""));
    if (!fs.existsSync(gitRoot)) throw new Error("所选目录不存在。");
    const identity = readGitIdentity(gitRoot);
    if (!identity.toplevel) throw new Error(identity.notARepository ? "所选目录不是 Git 仓库，不能登记为祖先项目。" : (identity.error || "无法读取 Git 身份。"));
    if (identity.error) throw new Error(`Git 状态读取失败，无法核实干净状态与身份，不能登记为祖先项目：${identity.error}`);
    if (!sameComparablePath(identity.toplevel, gitRoot)) throw new Error(`所选目录的实际 Git 根为 ${identity.toplevel}；请打开该根目录再登记。`);
    if (identity.detached || !identity.branch) throw new Error("祖先项目当前处于 detached HEAD 或无当前分支；请先切换到目标分支后再登记。");
    const file = this.store.load();
    this.assertRootsFree(file, gitRoot, "");
    const record: AncestorProjectRecord = {
      id: newRecordId(`ancestor|${gitRoot}`),
      label: String(input.label || "").trim() || path.basename(gitRoot),
      gitRoot,
      targetBranch: identity.branch,
      remoteName: String(input.remoteName || "").trim().slice(0, 200),
      remoteUrl: String(input.remoteUrl || "").trim().slice(0, 600),
      registeredAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.store.mutate((current) => ({ ...current, ancestors: [...current.ancestors, record] }));
    return record;
  }

  /** Registers an existing independent copy (worktree or clone) as an innovation branch. */
  async registerBranch(input: { ancestorId: string; label: string; workspaceRoot: string }): Promise<BranchProjectRecord> {
    const workspaceRoot = path.normalize(String(input.workspaceRoot || ""));
    const file = this.store.load();
    const ancestor = file.ancestors.find((row) => row.id === input.ancestorId);
    if (!ancestor) throw new Error("请先登记祖先项目。");
    if (!fs.existsSync(workspaceRoot)) throw new Error("所选目录不存在。");
    const identity = readGitIdentity(workspaceRoot);
    if (!identity.toplevel) throw new Error(identity.notARepository ? "所选目录不是 Git 仓库；创新分支必须是带分支的仓库副本。" : (identity.error || "无法读取 Git 身份。"));
    if (identity.error) throw new Error(`Git 状态读取失败，无法核实身份，不能登记为创新分支：${identity.error}`);
    if (!sameComparablePath(identity.toplevel, workspaceRoot)) throw new Error(`所选目录的实际 Git 根为 ${identity.toplevel}；请打开该根目录再登记。`);
    if (identity.detached || !identity.branch) throw new Error("该副本处于 detached HEAD；创新分支必须停留在自己的分支上。");
    if (sameComparablePath(identity.toplevel, ancestor.gitRoot)) throw new Error("该目录就是祖先项目本身；创新分支需要独立副本。");
    this.assertRootsFree(file, workspaceRoot, "");
    const worktrees = listWorktrees(ancestor.gitRoot);
    // A separate clone may still share one object database via alternates; relation classification
    // stays in compareAncestorRelation (separate-repository is reported honestly, never guessed).
    const isWorktreeOfAncestor = worktrees.ok && worktrees.worktrees.some((row) => sameComparablePath(row.path, identity.toplevel));
    const record: BranchProjectRecord = {
      id: newRecordId(`branch|${workspaceRoot}`),
      label: String(input.label || "").trim() || `${ancestor.label}/${identity.branch}`,
      ancestorId: ancestor.id,
      workspaceRoot,
      branch: identity.branch,
      createdFromCommit: identity.headCommit,
      source: isWorktreeOfAncestor ? "created-worktree" : "registered-existing",
      registeredAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.store.mutate((current) => ({ ...current, branches: [...current.branches, record] }));
    return record;
  }

  /** Forget-only removal of a registration. Never touches files, branches, worktrees or commits. */
  async forget(kind: "ancestor" | "branch", id: string): Promise<void> {
    const file = this.store.load();
    if (kind === "branch") {
      if (!file.branches.some((row) => row.id === id)) throw new Error("该分支登记已不存在，请刷新。");
      await this.store.mutate((current) => ({ ...current, branches: current.branches.filter((row) => row.id !== id) }));
      return;
    }
    const attached = file.branches.filter((row) => row.ancestorId === id);
    if (attached.length > 0) throw new Error(`该祖先下还有 ${attached.length} 个分支登记；请先逐项移除分支登记。`);
    if (!file.ancestors.some((row) => row.id === id)) throw new Error("该祖先登记已不存在，请刷新。");
    await this.store.mutate((current) => ({ ...current, ancestors: current.ancestors.filter((row) => row.id !== id) }));
  }

  /** Read-only preview for creating a new branch worktree; the returned digest must be re-sent. */
  previewCreateBranch(input: { ancestorId: string; branch: string; targetParentDir: string }): CreateBranchPreview {
    const file = this.store.load();
    const ancestor = file.ancestors.find((row) => row.id === input.ancestorId);
    if (!ancestor) throw new Error("请先登记祖先项目。");
    const verification = this.verifyAncestor(ancestor, nowIso());
    if (verification.state === "missing" || verification.state === "not-a-repository" || verification.state === "error" || verification.state === "identity-drift" || verification.state === "detached")
      throw new Error(`祖先项目状态为 ${verification.state}：${verification.errors.join(" ")}`);
    const branch = String(input.branch || "").trim();
    const nameCheck = checkBranchNameFree(ancestor.gitRoot, branch);
    if (!nameCheck.ok) throw new Error(nameCheck.error);
    if (nameCheck.exists) throw new Error(`分支 ${branch} 已存在；不会覆盖。`);
    const parent = path.normalize(String(input.targetParentDir || ""));
    if (!fs.existsSync(parent)) throw new Error("目标父目录不存在。");
    const targetPath = path.join(parent, `${path.basename(ancestor.gitRoot)}--${branch.replace(/[\\/]/g, "-")}`);
    if (fs.existsSync(targetPath)) throw new Error(`目标目录 ${targetPath} 已存在；不会覆盖。`);
    const warnings: string[] = [];
    if (verification.state === "dirty") warnings.push("祖先工作区当前有未提交修改：新分支只从已提交的基点创建，不会携带未提交内容。");
    return {
      digest: createBranchPreviewDigest({ ancestorId: ancestor.id, ancestorRoot: ancestor.gitRoot, baseRef: ancestor.targetBranch, baseCommit: verification.git.headCommit, branch, targetPath }),
      ancestorLabel: ancestor.label,
      ancestorRoot: ancestor.gitRoot,
      baseRef: ancestor.targetBranch,
      baseCommit: verification.git.headCommit,
      branch,
      targetPath,
      warnings,
    };
  }

  /**
   * Executes the previewed creation after the user confirmed the digest. Everything is rechecked
   * against drift immediately before the write; a mismatched digest or identity is a hard refusal.
   */
  async confirmCreateBranch(input: CreateBranchRequest): Promise<CreateBranchResult> {
    const preview = this.previewCreateBranch(input);
    if (!input.confirmDigest || input.confirmDigest !== preview.digest)
      throw new Error("祖先状态、分支名或目标目录在确认后发生了变化；请重新预览确认。");
    const file = this.store.load();
    const ancestor = file.ancestors.find((row) => row.id === input.ancestorId);
    if (!ancestor) throw new Error("祖先登记已不存在；操作已停止。");
    const created = createWorktreeBranch({ ancestorRoot: ancestor.gitRoot, baseRef: preview.baseRef, branch: preview.branch, targetPath: preview.targetPath });
    if (!created.ok) throw new Error(`${created.error}${created.detail ? ` ${created.detail}` : ""}`);
    const now = nowIso();
    const record: BranchProjectRecord = {
      id: newRecordId(`branch|${preview.targetPath}`),
      label: `${ancestor.label}/${preview.branch}`,
      ancestorId: ancestor.id,
      workspaceRoot: preview.targetPath,
      branch: preview.branch,
      createdFromCommit: preview.baseCommit,
      source: "created-worktree",
      registeredAt: now,
      updatedAt: now,
    };
    await this.store.mutate((current) => ({ ...current, branches: [...current.branches, record] }));
    return { ok: true, message: `已创建本机 worktree 分支并登记：${preview.targetPath}`, record };
  }

  private assertRootsFree(file: BranchProjectFile, root: string, _excludeId: string): void {
    const key = canonicalComparablePath(root);
    if (file.ancestors.some((row) => canonicalComparablePath(row.gitRoot) === key)) throw new Error(`目录 ${root} 已登记为祖先项目。`);
    if (file.branches.some((row) => canonicalComparablePath(row.workspaceRoot) === key)) throw new Error(`目录 ${root} 已登记为分支项目。`);
  }
}
