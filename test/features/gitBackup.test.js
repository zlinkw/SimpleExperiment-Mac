const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const GitBackup = require("../../dist/features/GitBackup.js");

const {
  HOOK_BLOCK_BEGIN,
  HOOK_BLOCK_END,
  buildHookBlock,
  inspectGitBackup,
  installBackupHook,
  stripHookBlock,
  uninstallBackupHook,
} = GitBackup;

const tempDirs = [];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-gitbackup-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  return dir;
}

function writeHook(repo, content) {
  const hp = GitBackup.resolveHookPath(repo);
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, content, "utf8");
  return hp;
}

function findShell() {
  for (const candidate of ["sh", "bash"]) {
    try {
      execFileSync(candidate, ["-c", "exit 0"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return "";
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("全新仓库：安装后创建带标记的 hook，行尾为 LF 且可执行", () => {
  const repo = makeRepo();
  const result = installBackupHook(repo, "origin");

  assert.equal(result.changed, true);
  const content = fs.readFileSync(result.hookPath, "utf8");
  assert.ok(content.startsWith("#!/bin/sh"), "必须带 shebang");
  assert.ok(content.includes(HOOK_BLOCK_BEGIN), "必须含起始标记");
  assert.ok(content.includes(HOOK_BLOCK_END), "必须含结束标记");
  assert.ok(!content.includes("\r"), "hook 必须是 LF 行尾");
});

test("已有 post-commit：追加标记段并完整保留原有逻辑", () => {
  const repo = makeRepo();
  const hp = writeHook(repo, '#!/bin/sh\necho "original hook"\n');

  const result = installBackupHook(repo, "origin");
  assert.equal(result.changed, true);

  const content = fs.readFileSync(hp, "utf8");
  assert.ok(content.includes('echo "original hook"'), "原有逻辑必须保留");
  assert.ok(content.includes(HOOK_BLOCK_BEGIN), "必须写入标记段");
  assert.ok(
    content.indexOf("original hook") < content.indexOf(HOOK_BLOCK_BEGIN),
    "原有逻辑应在标记段之前"
  );
});

test("已有 hook 缺少 shebang：安装时自动补齐", () => {
  const repo = makeRepo();
  const hp = writeHook(repo, 'echo "no shebang"\n');

  installBackupHook(repo, "origin");

  const content = fs.readFileSync(hp, "utf8");
  assert.ok(content.startsWith("#!/bin/sh"), "应补齐 shebang");
  assert.ok(content.includes('echo "no shebang"'), "原有逻辑必须保留");
});

test("幂等：重复安装不改变文件内容", () => {
  const repo = makeRepo();
  installBackupHook(repo, "origin");
  const hp = GitBackup.resolveHookPath(repo);
  const first = fs.readFileSync(hp, "utf8");

  const second = installBackupHook(repo, "origin");
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(hp, "utf8"), first);
});

test("切换 remote：重新安装会替换标记段而非叠加", () => {
  const repo = makeRepo();
  installBackupHook(repo, "origin");
  const hp = GitBackup.resolveHookPath(repo);

  installBackupHook(repo, "upstream");
  const content = fs.readFileSync(hp, "utf8");

  assert.equal(content.split(HOOK_BLOCK_BEGIN).length - 1, 1, "标记段只能出现一次");
  assert.ok(content.includes("upstream"), "应使用新的 remote 名");
});

test("卸载：移除标记段并恢复原有逻辑", () => {
  const repo = makeRepo();
  const hp = writeHook(repo, '#!/bin/sh\necho "keep me"\n');
  installBackupHook(repo, "origin");

  const result = uninstallBackupHook(repo);
  assert.equal(result.changed, true);

  const content = fs.readFileSync(hp, "utf8");
  assert.ok(!content.includes(HOOK_BLOCK_BEGIN), "标记段应被移除");
  assert.ok(content.includes('echo "keep me"'), "原有逻辑必须保留");
});

test("卸载纯插件 hook：文件被删除", () => {
  const repo = makeRepo();
  const installed = installBackupHook(repo, "origin");

  const result = uninstallBackupHook(repo);
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(installed.hookPath), true, "保留 Git hook 文件以避免插件删除用户文件");
  assert.equal(fs.readFileSync(installed.hookPath, "utf8"), "#!/bin/sh\n");
});

test("卸载未安装的 hook：changed=false", () => {
  const repo = makeRepo();
  const result = uninstallBackupHook(repo);
  assert.equal(result.changed, false);
});

test("inspect：正确识别仓库状态、remote 与安装状态", () => {
  const repo = makeRepo();

  let info = inspectGitBackup(repo, "origin");
  assert.equal(info.isGitRepo, true);
  assert.equal(info.hasRemote, false);
  assert.equal(info.hookInstalled, false);
  assert.equal(info.repoRoot.replace(/\\/g, "/").toLowerCase(), repo.replace(/\\/g, "/").toLowerCase());

  git(["remote", "add", "origin", "https://example.com/a/b.git"], repo);
  info = inspectGitBackup(repo, "origin");
  assert.equal(info.hasRemote, true);
  assert.equal(info.remoteName, "origin");
  assert.equal(info.remoteUrl, "https://example.com/a/b.git");

  installBackupHook(repo, "origin");
  info = inspectGitBackup(repo, "origin");
  assert.equal(info.hookInstalled, true);
  assert.equal(info.hookHasForeignContent, false, "纯插件 hook 不算外部内容");
});

test("inspect：非 git 目录返回 isGitRepo=false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-nogit-"));
  tempDirs.push(dir);
  const info = inspectGitBackup(dir, "origin");
  assert.equal(info.isGitRepo, false);
  assert.equal(info.hasRemote, false);
});

test("pickRemote：无 remote 返回空，优先使用指定名称", () => {
  const repo = makeRepo();
  assert.equal(GitBackup.pickRemote(repo, "origin"), "");

  git(["remote", "add", "upstream", "https://example.com/u.git"], repo);
  assert.equal(GitBackup.pickRemote(repo, "origin"), "upstream", "无 origin 时回退到第一个");
  assert.equal(GitBackup.pickRemote(repo, "upstream"), "upstream");

  git(["remote", "add", "origin", "https://example.com/o.git"], repo);
  assert.equal(GitBackup.pickRemote(repo, "origin"), "origin", "有 origin 时优先 origin");
});

test("stripHookBlock：仅移除标记段，不损伤原有内容", () => {
  const raw = `#!/bin/sh\necho a\n\n${buildHookBlock("origin")}\n`;
  const stripped = stripHookBlock(raw);
  assert.ok(!stripped.includes(HOOK_BLOCK_BEGIN));
  assert.ok(stripped.includes("echo a"));
});

test("生成的 hook 片段是合法 shell 语法", (t) => {
  const shell = findShell();
  if (!shell) {
    t.skip("环境无 sh/bash，跳过语法校验");
    return;
  }
  const repo = makeRepo();
  const hp = writeHook(repo, `#!/bin/sh\n${buildHookBlock("origin")}\n`);
  execFileSync(shell, ["-n"], { input: fs.readFileSync(hp, "utf8"), stdio: ["pipe", "pipe", "pipe"] });
});

test("remote 名含非法字符时回退到 origin，不注入 shell", () => {
  const block = buildHookBlock("origin; rm -rf /");
  assert.ok(block.includes("git push --quiet origin "), "非法名称应回退为 origin");
  assert.ok(!block.includes("rm -rf"), "不得注入任意命令");
});

test("端到端：提交后 hook 自动推送到远程", () => {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "se-remote-"));
  tempDirs.push(remoteDir);
  execFileSync("git", ["init", "--bare", "-q", remoteDir], { stdio: ["ignore", "pipe", "pipe"] });

  const repo = makeRepo();
  git(["remote", "add", "origin", remoteDir], repo);
  installBackupHook(repo, "origin");

  const branch = git(["symbolic-ref", "--short", "HEAD"], repo).trim();
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
  git(["add", "-A"], repo);
  // commit 会触发 post-commit hook
  execFileSync("git", ["commit", "-q", "-m", "e2e"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const localHead = git(["rev-parse", "HEAD"], repo).trim();
  const remoteHead = git(["rev-parse", branch], remoteDir).trim();
  assert.equal(remoteHead, localHead, "远程应与本地 HEAD 一致，证明 hook 完成了推送");
});
