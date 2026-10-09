/**
 * GitBackup - 为工作区 git 仓库自动配置「提交即推送」备份
 *
 * 纯逻辑模块（不依赖 vscode），供 Activation 与命令层调用。
 *
 * 设计要点：
 * - 只在仓库已配置 remote 时安装，避免写入注定失败的 hook
 * - 追加模式：保留仓库原有 post-commit 逻辑，用标记段包裹，可反复安装/卸载
 * - 幂等：重复安装替换标记段而非叠加
 * - hook 强制 LF 行尾 + 可执行位（Linux/macOS 下 git 要求）
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const HOOK_BLOCK_BEGIN = "# >>> simple-experiment git-backup >>>";
export const HOOK_BLOCK_END = "# <<< simple-experiment git-backup <<<";
export const DEFAULT_REMOTE = "origin";

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface GitBackupInspection {
  isGitRepo: boolean;
  repoRoot: string;
  hookPath: string;
  hookExists: boolean;
  hookInstalled: boolean;
  hookHasForeignContent: boolean;
  hasRemote: boolean;
  remoteName: string;
  remoteUrl: string;
  remotes: string[];
}

export interface InstallResult {
  changed: boolean;
  reason: string;
  hookPath: string;
}

function toText(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

export function runGit(args: string[], cwd: string, timeoutMs = 15000): GitCommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: toText(stdout), stderr: "" };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = toText(err.stderr).trim();
    return { ok: false, stdout: toText(err.stdout), stderr: stderr || String(err.message || error) };
  }
}

export function findRepoRoot(cwd: string): string {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!result.ok) return "";
  return result.stdout.trim();
}

export function resolveHookPath(repoRoot: string): string {
  const result = runGit(["rev-parse", "--git-path", "hooks/post-commit"], repoRoot);
  const raw = result.ok ? result.stdout.trim() : "";
  if (raw) return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
  return path.join(repoRoot, ".git", "hooks", "post-commit");
}

export function readHookFile(hookPath: string): string {
  try {
    return fs.readFileSync(hookPath, "utf8");
  } catch {
    return "";
  }
}

/** 移除插件写入的标记段，保留仓库原有 hook 逻辑。 */
export function stripHookBlock(content: string): string {
  const begin = content.indexOf(HOOK_BLOCK_BEGIN);
  if (begin < 0) return content;
  const end = content.indexOf(HOOK_BLOCK_END, begin);
  const before = content.slice(0, begin);
  const after = end < 0 ? "" : content.slice(end + HOOK_BLOCK_END.length);
  return (before + after).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function listRemotes(repoRoot: string): string[] {
  const result = runGit(["remote"], repoRoot);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function pickRemote(repoRoot: string, preferred?: string): string {
  const remotes = listRemotes(repoRoot);
  if (!remotes.length) return "";
  const wanted = (preferred || "").trim();
  if (wanted && remotes.includes(wanted)) return wanted;
  if (remotes.includes(DEFAULT_REMOTE)) return DEFAULT_REMOTE;
  return remotes[0];
}

export function getRemoteUrl(repoRoot: string, remoteName: string): string {
  if (!remoteName) return "";
  const result = runGit(["remote", "get-url", remoteName], repoRoot);
  return result.ok ? result.stdout.trim() : "";
}

export function inspectGitBackup(cwd: string, preferredRemote?: string): GitBackupInspection {
  const empty: GitBackupInspection = {
    isGitRepo: false,
    repoRoot: "",
    hookPath: "",
    hookExists: false,
    hookInstalled: false,
    hookHasForeignContent: false,
    hasRemote: false,
    remoteName: "",
    remoteUrl: "",
    remotes: [],
  };

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return empty;

  const hookPath = resolveHookPath(repoRoot);
  const hookContent = readHookFile(hookPath);
  const hookExists = fs.existsSync(hookPath);
  const stripped = stripHookBlock(hookContent).trim();
  const hookHasForeignContent = stripped.length > 0 && stripped !== "#!/bin/sh";

  const remotes = listRemotes(repoRoot);
  const remoteName = pickRemote(repoRoot, preferredRemote);

  return {
    isGitRepo: true,
    repoRoot,
    hookPath,
    hookExists,
    hookInstalled: hookContent.includes(HOOK_BLOCK_BEGIN),
    hookHasForeignContent,
    hasRemote: remotes.length > 0,
    remoteName,
    remoteUrl: getRemoteUrl(repoRoot, remoteName),
    remotes,
  };
}

/** 生成插件写入的 hook 片段（shell，LF）。 */
export function buildHookBlock(remoteName: string): string {
  const remote = REMOTE_NAME_PATTERN.test(remoteName) ? remoteName : DEFAULT_REMOTE;
  return [
    HOOK_BLOCK_BEGIN,
    "# 由 SimpleExperiment 插件写入：提交后自动推送当前分支到远程",
    "__se_branch=$(git symbolic-ref --short HEAD 2>/dev/null) || __se_branch=\"\"",
    'if [ -n "$__se_branch" ]; then',
    `  if ! GIT_TERMINAL_PROMPT=0 git push --quiet ${remote} "$__se_branch"; then`,
    `    printf "\\n[SimpleExperiment] 备份失败：分支 %s 未推送到 ${remote}。请手动执行：git push ${remote} %s\\n\\n" "$__se_branch" "$__se_branch"`,
    "  fi",
    "fi",
    HOOK_BLOCK_END,
  ].join("\n");
}

/** 安装或更新备份 hook。已有标记段则替换，否则追加，绝不丢弃仓库原有逻辑。 */
export function installBackupHook(repoRoot: string, remoteName: string): InstallResult {
  const hookPath = resolveHookPath(repoRoot);
  const existing = readHookFile(hookPath);
  const hadBlock = existing.includes(HOOK_BLOCK_BEGIN);

  let base = stripHookBlock(existing);
  if (base && !base.startsWith("#!")) {
    base = `#!/bin/sh\n${base}`;
  }

  const block = buildHookBlock(remoteName);
  const next = `${base ? `${base}\n\n` : "#!/bin/sh\n\n"}${block}\n`;

  if (next === existing) {
    return { changed: false, reason: "已是最新，无需变更", hookPath };
  }

  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, next.replace(/\r\n/g, "\n"), { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* Windows 上可执行位无意义，忽略 */
  }

  let reason = "已创建";
  if (hadBlock) reason = "已更新标记段";
  else if (base) reason = "已追加（原有逻辑保留）";
  return { changed: true, reason, hookPath };
}

/** 移除插件写入的标记段；保留 hook 文件，避免删除失败被误报为成功。 */
export function uninstallBackupHook(repoRoot: string): InstallResult {
  const hookPath = resolveHookPath(repoRoot);
  const existing = readHookFile(hookPath);
  if (!existing.includes(HOOK_BLOCK_BEGIN)) {
    return { changed: false, reason: "未检测到插件 hook", hookPath };
  }
  const stripped = stripHookBlock(existing);
  if (!stripped || stripped === "#!/bin/sh") {
    fs.writeFileSync(hookPath, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    const persisted = readHookFile(hookPath);
    if (persisted.includes(HOOK_BLOCK_BEGIN)) throw new Error(`Git backup hook marker remained after removal: ${hookPath}`);
    return { changed: true, reason: "已移除插件逻辑（保留空 hook 文件）", hookPath };
  }
  fs.writeFileSync(hookPath, `${stripped}\n`, { encoding: "utf8", mode: 0o755 });
  const persisted = readHookFile(hookPath);
  if (persisted.includes(HOOK_BLOCK_BEGIN)) throw new Error(`Git backup hook marker remained after removal: ${hookPath}`);
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* ignore */
  }
  return { changed: true, reason: "已移除标记段（原有逻辑保留）", hookPath };
}

/** 探测远程可达性与凭据是否可用。 */
export function checkRemoteAccess(repoRoot: string, remoteName: string, timeoutMs = 10000): GitCommandResult {
  if (!remoteName) return { ok: false, stdout: "", stderr: "未配置 remote" };
  return runGit(["ls-remote", "--exit-code", remoteName, "HEAD"], repoRoot, timeoutMs);
}
