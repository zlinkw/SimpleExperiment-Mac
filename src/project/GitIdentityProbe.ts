/**
 * src/project/GitIdentityProbe.ts - read-only Git identity probes for the ancestor/branch registry.
 *
 * Every probe clears inherited git-location variables (GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/
 * GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_PREFIX/GIT_NAMESPACE/
 * GIT_CONFIG) so a caller process that already runs under an exported git environment can never
 * make these commands inspect or touch a different repository than the directory we pass as cwd.
 * The only non-read-only command in this module is createWorktreeBranch, which the panel exposes
 * exclusively behind an explicit user preview+confirm; it never resets, rebases, stashes, forces
 * or deletes anything, and it refuses when the branch or target path is already taken.
 */
import * as childProcess from "child_process";
import * as path from "path";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Case-insensitive names; Windows env lookup is case-insensitive, so prune by lowercase. */
const INHERITED_GIT_ENV_NAMES = [
  "git_dir",
  "git_work_tree",
  "git_common_dir",
  "git_index_file",
  "git_object_directory",
  "git_alternate_object_directories",
  "git_prefix",
  "git_namespace",
  "git_config",
  "git_config_global",
  "git_config_system",
];

export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (INHERITED_GIT_ENV_NAMES.includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export interface GitCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGitCommand(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): GitCommandResult {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("git 探针需要绝对工作目录。");
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || !arg))
    throw new Error("git 探针参数必须为非空字符串数组。");
  const spawned = childProcess.spawnSync("git", args, {
    cwd,
    env: sanitizeGitEnv(process.env),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (spawned.error && (spawned.error as { code?: unknown }).code === "ETIMEDOUT")
    return { ok: false, code: -1, stdout: String(spawned.stdout || ""), stderr: "git 命令超时。", timedOut: true };
  if (spawned.error && spawned.signal)
    return { ok: false, code: -1, stdout: String(spawned.stdout || ""), stderr: `git 命令被信号中断：${spawned.signal}`, timedOut: true };
  if (spawned.error)
    return { ok: false, code: -1, stdout: "", stderr: String((spawned.error as Error).message || spawned.error), timedOut: false };
  return {
    ok: spawned.status === 0,
    code: Number(spawned.status),
    stdout: String(spawned.stdout || ""),
    stderr: String(spawned.stderr || ""),
    timedOut: false,
  };
}

export interface GitIdentity {
  /** Absolute canonical toplevel reported by git itself; "" when not a repository. */
  toplevel: string;
  /** Absolute common dir (shared object database); distinguishes worktrees of one repo from separate clones. */
  commonDir: string;
  /** true when `git` executed but the directory is not inside a work tree. */
  notARepository: boolean;
  /** Current branch short name; "" when detached. */
  branch: string;
  detached: boolean;
  /** HEAD commit sha; "" for an unborn HEAD. */
  headCommit: string;
  /** Any tracked/staged/untracked change reported by --no-optional-locks status. */
  dirty: boolean;
  remotes: Array<{ name: string; url: string }>;
  /** Raw failure text when any probe step failed fatally. */
  error: string;
}

function resolveCommonDir(cwd: string, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

/** Read-only identity of the git repository that owns `cwd`. Never writes; uses --no-optional-locks. */
export function readGitIdentity(cwd: string): GitIdentity {
  const identity: GitIdentity = { toplevel: "", commonDir: "", notARepository: false, branch: "", detached: false, headCommit: "", dirty: false, remotes: [], error: "" };
  const toplevel = runGitCommand(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    identity.notARepository = /not a git repository/i.test(toplevel.stderr);
    identity.error = toplevel.timedOut ? toplevel.stderr : (toplevel.stderr.trim() || "git rev-parse 失败。");
    return identity;
  }
  identity.toplevel = path.normalize(toplevel.stdout.trim());
  let commonDir = runGitCommand(identity.toplevel, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir.ok) commonDir = runGitCommand(identity.toplevel, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok) { identity.error = commonDir.stderr.trim() || "git common-dir 读取失败。"; return identity; }
  identity.commonDir = resolveCommonDir(identity.toplevel, commonDir.stdout);
  const branch = runGitCommand(identity.toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.ok) identity.branch = branch.stdout.trim();
  else identity.detached = true;
  const head = runGitCommand(identity.toplevel, ["rev-parse", "--verify", "HEAD"]);
  if (head.ok) identity.headCommit = head.stdout.trim();
  const status = runGitCommand(identity.toplevel, ["--no-optional-locks", "status", "--porcelain=v1"]);
  if (!status.ok) { identity.error = status.stderr.trim() || "git status 读取失败。"; return identity; }
  identity.dirty = status.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
  const remotes = runGitCommand(identity.toplevel, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (remotes.ok) {
    for (const line of remotes.stdout.split(/\r?\n/)) {
      const match = /^remote\.(.+)\.url\s+(.*)$/.exec(line.trim());
      if (match) identity.remotes.push({ name: match[1], url: match[2].trim() });
    }
  }
  return identity;
}

export interface GitWorktreeRow {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain` of the repository owning `cwd` (read-only). */
export function listWorktrees(cwd: string): { ok: boolean; error: string; worktrees: GitWorktreeRow[] } {
  const result = runGitCommand(cwd, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return { ok: false, error: result.stderr.trim() || "git worktree list 失败。", worktrees: [] };
  const worktrees: GitWorktreeRow[] = [];
  let current: GitWorktreeRow | undefined;
  const flush = () => { if (current) worktrees.push(current); current = undefined; };
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { flush(); current = { path: path.normalize(line.slice("worktree ".length).trim()), head: "", branch: "", bare: false, prunable: false }; continue; }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) current.branch = path.basename(line.slice(7).trim());
    else if (line.trim() === "bare") current.bare = true;
    else if (line.trim().startsWith("prunable")) current.prunable = true;
  }
  flush();
  return { ok: true, error: "", worktrees };
}

export type AncestorRelation =
  | "ancestor-equal"        // same commit
  | "ancestor-ahead"        // ancestor HEAD is a strict ancestor of branch HEAD
  | "diverged"              // neither is an ancestor of the other
  | "separate-repository"   // different object databases: relation cannot be proven locally
  | "unavailable";          // one side cannot be read right now

/**
 * Relation between two read identities. Only repos sharing one object database (same common dir,
 * i.e. worktrees of one repository) can be proven ancestor-related without a network fetch; a
 * separate clone is reported honestly as separate-repository and is never "guessed" related.
 */
export function compareAncestorRelation(ancestor: GitIdentity, branch: GitIdentity): AncestorRelation {
  if (!ancestor.toplevel || !branch.toplevel || !ancestor.headCommit || !branch.headCommit) return "unavailable";
  const sameRepo = ancestor.commonDir && branch.commonDir
    && ancestor.commonDir.toLowerCase() === branch.commonDir.toLowerCase();
  if (!sameRepo) return "separate-repository";
  if (ancestor.headCommit === branch.headCommit) return "ancestor-equal";
  const isAncestor = runGitCommand(ancestor.toplevel, ["merge-base", "--is-ancestor", ancestor.headCommit, branch.headCommit]);
  if (isAncestor.ok) return "ancestor-ahead";
  if (isAncestor.code === 1) return "diverged";
  return "unavailable";
}

export interface BranchNameCheck {
  ok: boolean;
  error: string;
  /** true when refs/heads/<branch> already exists in the repository. */
  exists: boolean;
}

export function checkBranchNameFree(cwd: string, branch: string): BranchNameCheck {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.includes("//"))
    return { ok: false, error: `分支名不合法或含受限序列：${branch}`, exists: true };
  const result = runGitCommand(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (result.ok && result.stdout.trim()) return { ok: true, error: "", exists: true };
  if (result.code === 1) return { ok: true, error: "", exists: false };
  return { ok: false, error: result.stderr.trim() || "git branch 查询失败。", exists: true };
}

export interface CreateWorktreeRequest {
  /** Repository root the new worktree branches off. */
  ancestorRoot: string;
  /** Ref or commit the new branch starts from (must resolve inside this repository). */
  baseRef: string;
  /** New branch name; must not exist yet. */
  branch: string;
  /** Absolute path of the new worktree directory; must not exist (git also enforces this). */
  targetPath: string;
}

export interface CreateWorktreeOutcome {
  ok: boolean;
  error: string;
  /** Full git stderr/stdout kept for the panel diagnostic line; never contains secrets by git itself. */
  detail: string;
}

/**
 * The one approved local Git write of block A: `git worktree add <path> -b <branch> <base>`.
 * Callers must have shown the user an exact preview (paths, branch, base) and rechecked identity
 * drift immediately before this call. Refusals are returned, never retried, and nothing here ever
 * resets, rebases, stashes, force-updates, prunes or deletes repositories, worktrees or files.
 */
export function createWorktreeBranch(request: CreateWorktreeRequest): CreateWorktreeOutcome {
  const ancestorRoot = path.normalize(request.ancestorRoot || "");
  if (!ancestorRoot || !path.isAbsolute(ancestorRoot)) return { ok: false, error: "祖先项目目录必须是绝对路径。", detail: "" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(request.branch || "") || (request.branch || "").includes("..") || (request.branch || "").endsWith("/"))
    return { ok: false, error: `分支名不合法：${String(request.branch || "")}`, detail: "" };
  const targetPath = path.normalize(request.targetPath || "");
  if (!targetPath || !path.isAbsolute(targetPath)) return { ok: false, error: "新分支目录必须是绝对路径。", detail: "" };
  if (!String(request.baseRef || "").trim()) return { ok: false, error: "缺少分支基点引用。", detail: "" };
  const nameCheck = checkBranchNameFree(ancestorRoot, request.branch);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error, detail: "" };
  if (nameCheck.exists) return { ok: false, error: `分支 ${request.branch} 已存在；不会覆盖已有分支。`, detail: "" };
  const created = runGitCommand(ancestorRoot, ["worktree", "add", targetPath, "-b", request.branch, request.baseRef], 60_000);
  if (!created.ok)
    return { ok: false, error: "创建本机 worktree 分支失败，未做任何破坏性补救。", detail: `${created.stderr}\n${created.stdout}`.trim().slice(0, 2000) };
  return { ok: true, error: "", detail: `${created.stderr}\n${created.stdout}`.trim().slice(0, 2000) };
}
