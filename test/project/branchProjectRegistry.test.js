/**
 * 块A：祖先项目/创新分支登记（模型、本机存储、只读 Git 身份探针与登记服务）。
 *
 * 变更前的缺失行为（先记录，再断言新行为）：
 * - 插件不存在任何“祖先项目/创新分支”登记模型，也没有带继承 GIT_* 定位变量清理的只读身份探针；
 *   跨窗口/多副本归属只能人工换算。
 * - 面板登记动作（创建分支 worktree）没有“预览→digest 一致确认→写前重核”的拒绝路径，
 *   无法保证不覆盖已有分支/目录、不在身份漂移时写入。
 *
 * 本文件断言的最小行为集合：
 * 1) sanitizeGitEnv 清除 GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/
 *    GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_PREFIX（含大小写变体）且保留其它环境项；
 *    readGitIdentity 在父环境被注入诱饵仓库定位变量时仍读取真实仓库，且诱饵索引字节不变。
 * 2) 身份分类：分支/commit/dirty/detached；祖先关系 equal/ahead/diverged/separate-repository。
 * 3) 存储：往返校验、拒绝未来 schemaVersion、拒绝重复目录、拒绝孤儿分支、mutate 摘要漂移拒绝。
 * 4) 服务：登记拒绝非仓库/detached/祖先自身；preview/confirm 摘要一致才创建 worktree；
 *    目标目录或分支已存在拒绝；确认阶段漂移拒绝；forget 只移除登记，不删目录/分支；
 *    验证与创建全程不改祖先 HEAD、分支集合与工作区内容。
 * 5) 块C3 HEAD↔已验 manifest 绑定：真实提交树 blob 字节逐文件核对；Git 忽略/未跟踪的磁盘依赖
 *    ＝无法证明此 HEAD（绝不 stage/commit）；size/SHA/类型/路径/摘要/revision 规则；
 *    dirty→clean 同 blob 复用；假执行器覆盖 cat-file 缺帧/非 blob/截断等如实失败类别。
 * 6) 块C4/C5 PR 适配：origin 规范化剥凭证、漂移/基线缺失/PR 未知一律不写；
 *    普通快推 argv、未知收据不重放、身份复用、merge 必须重查 MERGED、祖先 ff-only 真实仓验证。
 * 7) 块C4-R6（主控 2026-10-25 四处必须返修）：MERGED 只读恢复经模块 readOnly 真实取 mergeCommit 后才快进；
 *    祖先 ff 的 expected 只来自已确认 target（冻结），live 重读不得洗白确认后漂移；统一操作租约身份＝
 *    已确认仓＋head ref（与 cwd/拼写/base 无关，未知 target 先拒）；合并最终确认前必须展示所选科研证据。
 *    接线故障在真实 legacy 入口才暴露（helper 全绿也会漏），故用既有 AST 法身夹具提取实际方法体回归。
 *
 * 需要真实 git 子进程与临时仓库夹具，无法用纯内存 fake 替代（隔离/环境清理语义本身是被测行为），
 * 因此作为新功能域新建本文件；其余面板/路由断言扩在既有套件中。
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const store = require("../../dist/project/BranchProjectStore.js");
const probe = require("../../dist/project/GitIdentityProbe.js");
const { BranchProjectService } = require("../../dist/project/BranchProjectService.js");

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
// FIXTURE POLICY: zero cleanup — retained for audit instead of rmSync (与 test/api 2026-10-23 策略一致)。
// perf 2026-10-26：共享“模板仓”同样进入 tempDirs 留证集合，与其他夹具同命运（运行后保留，
// 由人工/既有清理流程处置）；本套件不新增任何删除或权限修改路径。
after(() => {
  for (const dir of tempDirs) console.log(`[fixtures retained, no cleanup] ${dir}`);
});

function gitGitEnv(extra = {}) {
  const env = probe.sanitizeGitEnv(process.env);
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", ...extra };
}
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitGitEnv() });
}
// 模板只准备一次；各测试得到完整字节副本，不共享可写 Git 元数据或硬链接。
// 模板落在此套件私有的随机临时目录（mkdtemp，每次运行独立），after() 只登记保留路径。
// 每个用例仍得到 --no-hardlinks 的完整独立副本：真实历史（base 空提交 + tracked.txt "base" 提交，
// 与原 makeRepo 逐字节同构）、独立 .git/refs/工作树，独占可写——隔离/互斥/真实 ff/worktree 语义不变，绝不 mock。
let templateRepo = null;
function ensureTemplateRepo() {
  if (templateRepo) return templateRepo;
  const dir = tempDir("se-branch-template-"); // 进 tempDirs 留证集合：模板与其他夹具同命运，运行后保留、不删除
  git(["init", "-q", dir], dir);
  git(["checkout", "-q", "-B", "main"], dir);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "--allow-empty", "-m", "base"], dir);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n", "utf8");
  git(["add", "-A"], dir);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "-m", "files"], dir);
  templateRepo = dir;
  return dir;
}
function makeRepo(name) {
  const seed = ensureTemplateRepo();
  const dir = tempDir(`se-branch-${name}-`);
  // makeRepo 的契约是独立、无 origin、具有同一初始真实历史的仓库；clone/remove origin
  // 并非被测行为。字节复制避免每个夹具重复启动这两个 Git 准备进程。测试中的真实 clone、
  // init、worktree、fetch、ff、身份探针及其断言继续原样执行。
  const copyTree = (source, target) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      assert.equal(fs.lstatSync(from).isSymbolicLink(), false, "模板禁止链接/重解析点");
      assert.equal(fs.existsSync(to), false, "夹具复制不能覆盖或合并既有目标");
      if (entry.isDirectory()) { fs.mkdirSync(to); copyTree(from, to); }
      else {
        assert.equal(entry.isFile(), true, "模板仅含普通文件/目录");
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        assert.notEqual(fs.statSync(from, { bigint: true }).ino, fs.statSync(to, { bigint: true }).ino, "每个文件必须独立，禁止硬链接");
      }
    }
  };
  copyTree(seed, dir);
  assert.equal(fs.realpathSync(path.join(dir, ".git")), path.join(fs.realpathSync(dir), ".git"), "Git 元数据只归本夹具");
  return dir;
}
function commitFile(repo, file, text, message) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); // 前序 git rm 可能已移除整个目录
  fs.writeFileSync(path.join(repo, file), text, "utf8");
  git(["add", "-A"], repo);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "-m", message], repo);
}
function snapshotRepoState(repo) {
  return {
    head: git(["rev-parse", "HEAD"], repo).trim(),
    branches: git(["branch", "--list", "--format=%(refname:short)"], repo).trim(),
    worktreeList: git(["worktree", "list", "--porcelain"], repo).trim(),
    status: git(["--no-optional-locks", "status", "--porcelain=v1"], repo),
  };
}
function newService(storeDir) {
  const storeInstance = new store.BranchProjectStore(path.join(storeDir, "branch-projects.json"));
  return new BranchProjectService(storeInstance, () => "");
}

test("sanitizeGitEnv 清除继承的 Git 定位变量并保留其它环境", () => {
  const env = {
    PATH: process.env.PATH || "",
    APPDATA: process.env.APPDATA || "C:\\AppData",
    GIT_DIR: "/tmp/decoy/.git",
    git_work_tree: "/tmp/decoy",
    GIT_COMMON_DIR: "/tmp/decoy/.git",
    GIT_INDEX_FILE: "/tmp/decoy/.git/index",
    GIT_OBJECT_DIRECTORY: "/tmp/decoy/.git/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/alt/objects",
    GIT_PREFIX: "sub/",
    GIT_NAMESPACE: "ns",
    GIT_CONFIG: "/tmp/decoy/config",
    SIMPLE_EXPERIMENT_KEEP: "keep-me",
  };
  const clean = probe.sanitizeGitEnv(env);
  for (const key of Object.keys(env)) {
    if (/^git_(dir|work_tree|common_dir|index_file|object_directory|alternate_object_directories|prefix|namespace|config)$/i.test(key))
      assert.ok(!(key in clean), `继承的 Git 定位变量 ${key} 必须被清除`);
  }
  assert.equal(clean.SIMPLE_EXPERIMENT_KEEP, "keep-me");
  assert.equal(typeof clean.PATH, "string");
});

test("readGitIdentity 在继承诱饵定位变量时仍读真实仓库且不写诱饵索引", () => {
  const repo = makeRepo("identity");
  const decoy = makeRepo("decoy");
  const decoyIndex = path.join(decoy, ".git", "index");
  const decoyIndexBefore = fs.existsSync(decoyIndex) ? fs.readFileSync(decoyIndex) : null;
  const decoyHeadBefore = git(["rev-parse", "HEAD"], decoy).trim();

  const saved = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE, idx: process.env.GIT_INDEX_FILE, common: process.env.GIT_COMMON_DIR };
  try {
    process.env.GIT_DIR = path.join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = decoyIndex;
    process.env.GIT_COMMON_DIR = path.join(decoy, ".git");
    const identity = probe.readGitIdentity(repo);
    assert.equal(identity.error, "");
    assert.equal(path.normalize(identity.toplevel), path.normalize(repo), "必须读取传入目录所在真实仓库");
    assert.equal(identity.branch, "main");
    assert.equal(identity.dirty, false);
    assert.match(identity.headCommit, /^[0-9a-f]{40}$/);
  } finally {
    for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.work], ["GIT_INDEX_FILE", saved.idx], ["GIT_COMMON_DIR", saved.common]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (decoyIndexBefore) assert.deepEqual(fs.readFileSync(decoyIndex), decoyIndexBefore, "诱饵仓库索引必须逐字节不变");
  assert.equal(git(["rev-parse", "HEAD"], decoy).trim(), decoyHeadBefore);
});

test("身份状态分类：dirty 与 detached 如实上报", () => {
  const repo = makeRepo("states");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n", "utf8");
  let identity = probe.readGitIdentity(repo);
  assert.equal(identity.dirty, true, "未跟踪文件属于未提交修改");

  const sha = git(["rev-parse", "HEAD~1"], repo).trim();
  git(["checkout", "-q", "--detach", sha], repo);
  identity = probe.readGitIdentity(repo);
  assert.equal(identity.detached, true);
  assert.equal(identity.branch, "");
  git(["checkout", "-q", "main"], repo);
});

test("祖先关系：同点/领先/分叉/独立仓库如实区分", () => {
  const repo = makeRepo("relation");
  commitFile(repo, "next.txt", "2\n", "next");
  const ancestorIdentity = probe.readGitIdentity(path.join(repo));
  const sameHead = { ...ancestorIdentity };
  assert.equal(probe.compareAncestorRelation(ancestorIdentity, sameHead), "ancestor-equal");

  const childPath = path.join(tempDir("se-child-parent-"), "child-worktree");
  git(["worktree", "add", "-q", "-b", "innovation/one", childPath, "main"], repo);
  commitFile(childPath, "child.txt", "c\n", "child commit");
  const childIdentity = probe.readGitIdentity(childPath);
  assert.equal(probe.compareAncestorRelation(ancestorIdentity, childIdentity), "ancestor-ahead", "worktree 提交后领先祖先");

  commitFile(repo, "ancestor-only.txt", "a\n", "ancestor moves");
  assert.equal(probe.compareAncestorRelation(probe.readGitIdentity(repo), childIdentity), "diverged");

  const cloneDir = tempDir("se-clone-");
  git(["clone", "-q", repo, path.join(cloneDir, "clone")], cloneDir);
  const cloneIdentity = probe.readGitIdentity(path.join(cloneDir, "clone"));
  assert.equal(probe.compareAncestorRelation(ancestorIdentity, cloneIdentity), "separate-repository", "独立 clone 不得被猜测为已证明关系");
});

test("登记文件：往返校验、未来版本拒绝、重复目录与摘要漂移拒绝", async () => {
  const dir = tempDir("se-branch-store-");
  const file = path.join(dir, "branch-projects.json");
  const ancestor = {
    id: "a".repeat(32), label: "祖先", gitRoot: path.resolve(path.sep, "repo", "ancestor"),
    targetBranch: "main", remoteName: "origin", remoteUrl: "", registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const branch = {
    id: "b".repeat(32), ancestorId: ancestor.id, label: "分支", workspaceRoot: path.resolve(path.sep, "repo", "branch"),
    branch: "innovation/one", createdFromCommit: "", source: "created-worktree", registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const branchStore = new store.BranchProjectStore(file);
  const saved = await branchStore.save({ schemaVersion: 1, ancestors: [ancestor], branches: [branch] });
  assert.equal(saved.ancestors.length, 1);
  assert.equal(branchStore.load().branches[0].branch, "innovation/one");

  assert.throws(() => store.parseBranchProjectFile(JSON.stringify({ schemaVersion: 2, ancestors: [], branches: [] })), /schemaVersion/);
  assert.throws(() => store.parseBranchProjectFile(JSON.stringify({ schemaVersion: 1, ancestors: [ancestor], branches: [{ ...branch, ancestorId: "c".repeat(32) }] })), /祖先关联缺失/);
  assert.throws(() => store.parseBranchProjectFile(JSON.stringify({ schemaVersion: 1, ancestors: [ancestor, { ...ancestor, id: "d".repeat(32), label: "重复" }], branches: [] })), /同一目录不能重复登记/);

  const digest = store.branchProjectFileDigest(saved);
  await assert.rejects(() => branchStore.mutate((current) => current, "0".repeat(32)), /刚被修改/);
  await branchStore.mutate((current) => ({ ...current, ancestors: current.ancestors.map((row) => ({ ...row, label: "改名" })) }), digest);
  assert.equal(branchStore.load().ancestors[0].label, "改名");
});

test("服务登记拒绝：非仓库、祖先自身、重复目录；成功登记如实记录身份", async () => {
  const dir = tempDir("se-branch-svc-");
  const repo = makeRepo("svc-ancestor");
  const nonRepo = tempDir("se-notrepo-");
  const service = newService(dir);
  await assert.rejects(() => service.registerAncestor({ label: "", gitRoot: nonRepo }), /不是 Git 仓库/);
  const record = await service.registerAncestor({ label: "", gitRoot: repo });
  assert.equal(record.targetBranch, "main");
  assert.equal(record.gitRoot, path.normalize(repo));
  await assert.rejects(() => service.registerBranch({ ancestorId: record.id, label: "", workspaceRoot: repo }), /就是祖先项目本身/);
  await assert.rejects(() => service.registerAncestor({ label: "dup", gitRoot: repo }), /已登记/);

  const projection = service.verifyAll();
  assert.equal(projection.ancestors[0].state, "verified");
  assert.equal(projection.ancestors[0].git.branch, "main");
  assert.equal(projection.branches.length, 0);
});

test("创建分支：预览/摘要一致才写，目标或分支占用拒绝，漂移拒绝，全程不动祖先", async () => {
  const dir = tempDir("se-branch-create-");
  const repo = makeRepo("create-ancestor");
  const parent = tempDir("se-branch-parent-");
  const service = newService(dir);
  const ancestor = await service.registerAncestor({ label: "", gitRoot: repo });
  const before = snapshotRepoState(repo);

  // previewCreateBranch 是同步函数：同步抛出必须用 assert.throws 捕获（rejects 只处理 Promise）。
  assert.throws(() => service.previewCreateBranch({ ancestorId: ancestor.id, branch: "main", targetParentDir: parent }), /已存在/);
  const takenDir = path.join(parent, "taken");
  fs.mkdirSync(takenDir);
  const previewTaken = service.previewCreateBranch({ ancestorId: ancestor.id, branch: "innovation/taken", targetParentDir: parent });
  // 摘要针对请求参数计算；把目标目录提前造出来后再确认，必须在写前被拒绝。
  fs.mkdirSync(previewTaken.targetPath);
  await assert.rejects(() => service.confirmCreateBranch({ ancestorId: ancestor.id, branch: "innovation/taken", targetParentDir: parent, confirmDigest: previewTaken.digest }), /已存在|发生了变化/);

  const preview = service.previewCreateBranch({ ancestorId: ancestor.id, branch: "innovation/demo", targetParentDir: parent });
  await assert.rejects(() => service.confirmCreateBranch({ ancestorId: ancestor.id, branch: "innovation/demo", targetParentDir: parent, confirmDigest: "f".repeat(32) }), /重新预览/);
  const result = await service.confirmCreateBranch({ ancestorId: ancestor.id, branch: "innovation/demo", targetParentDir: parent, confirmDigest: preview.digest });
  assert.ok(result.ok);
  assert.ok(fs.existsSync(path.join(preview.targetPath, ".git")), "新 worktree 目录应有 Git 工作区标记");
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], preview.targetPath).trim(), "innovation/demo");

  const afterState = snapshotRepoState(repo);
  assert.equal(afterState.head, before.head, "祖先 HEAD 不能因创建分支而移动");
  assert.equal(afterState.status, before.status, "祖先工作区内容不能被动过");
  assert.ok(afterState.branches.includes("innovation/demo"));
  assert.ok(!afterState.branches.includes("main~"), "分支列表只应有增无删");
  assert.equal(afterState.worktreeList.split("\n").filter((line) => line.startsWith("worktree ")).length, before.worktreeList.split("\n").filter((line) => line.startsWith("worktree ")).length + 1);

  const projection = service.verifyAll();
  const branchRow = projection.branches.find((row) => row.record.id === result.record.id);
  assert.equal(branchRow.state, "verified");
  assert.equal(branchRow.relation, "ancestor-equal");
  assert.equal(branchRow.researchValidated, false, "本卡只能证明 Git 身份，不能宣称科研验证通过");

  // 移除登记只动登记表：目录与分支仍在。
  await service.forget("branch", result.record.id);
  assert.ok(fs.existsSync(preview.targetPath), "移除登记不得删除 worktree 目录");
  await assert.rejects(() => service.forget("ancestor", "0".repeat(32)), /不存在/);
  await service.forget("ancestor", ancestor.id);
  assert.equal(service.verifyAll().ancestors.length, 0);
  assert.equal(snapshotRepoState(repo).head, before.head);
});

test("登记已有副本：worktree 记录来源，独立 clone 保持 separate-repository", async () => {
  const dir = tempDir("se-branch-reg-");
  const repo = makeRepo("reg-ancestor");
  const cloneDir = tempDir("se-reg-clone-");
  git(["clone", "-q", "-b", "main", repo, path.join(cloneDir, "copy")], cloneDir);
  git(["checkout", "-q", "-b", "innovation/clone-branch"], path.join(cloneDir, "copy"));
  const service = newService(dir);
  const ancestor = await service.registerAncestor({ label: "", gitRoot: repo });
  const record = await service.registerBranch({ ancestorId: ancestor.id, label: "", workspaceRoot: path.join(cloneDir, "copy") });
  assert.equal(record.source, "registered-existing");
  assert.equal(record.branch, "innovation/clone-branch");
  const projection = service.verifyAll();
  assert.equal(projection.branches[0].relation, "separate-repository");
  assert.equal(git(["rev-parse", "HEAD"], path.join(cloneDir, "copy")).trim(), record.createdFromCommit, "登记与验证不得移动副本提交");
  // 项目卡准备提示（锚点：BranchProjectService 分支副本 dirty 展示行）：本机运行状态 simple_cluster/state/
  // 也会报未跟踪，提示用户以本机 Git 排除规则排除该状态目录，并明确勿忽略整个目录、插件不代改 Git 配置。
  fs.writeFileSync(path.join(cloneDir, "copy", "scratch-untracked.txt"), "s\n", "utf8");
  const dirtyRow = service.verifyAll().branches[0];
  assert.ok(dirtyRow.errors.some(row => /分支副本存在未提交修改/.test(row) && /simple_cluster\/state\//.test(row)
    && /请勿忽略整个 simple_cluster\//.test(row) && /不代改 Git 配置/.test(row)), JSON.stringify(dirtyRow.errors));
  assert.equal(git(["rev-parse", "HEAD"], path.join(cloneDir, "copy")).trim(), record.createdFromCommit, "验证提示为只读，不改仓库状态");
});

test("Git 状态读取失败（受控损坏索引夹具）：验证/登记/预览确认全链拒绝，绝不标 verified", async () => {
  const dir = tempDir("se-branch-statusfail-");
  const repo = makeRepo("statusfail-ancestor");
  const before = snapshotRepoState(repo);
  const service = newService(dir);
  const ancestor = await service.registerAncestor({ label: "", gitRoot: repo });
  // 受控夹具：破坏 .git/index —— rev-parse/symbolic-ref 仍可读（toplevel 有值），但 git status 致命失败。
  fs.writeFileSync(path.join(repo, ".git", "index"), "corrupt-index-fixture-payload-not-a-git-index");
  const projection = service.verifyAll();
  const row = projection.ancestors.find((item) => item.record.id === ancestor.id);
  assert.equal(row.state, "error", "status 读取失败绝不能标 verified/dirty=false=干净");
  assert.ok(row.errors.some((text) => /读取失败/.test(text)), "必须保留真实失败原因");
  const targetParent = tempDir("se-statusfail-target-");
  assert.throws(() => service.previewCreateBranch({ ancestorId: ancestor.id, branch: "innovation/x1", targetParentDir: targetParent }), /读取失败|error/);
  await assert.rejects(() => service.confirmCreateBranch({ ancestorId: ancestor.id, branch: "innovation/x1", targetParentDir: targetParent, confirmDigest: "0".repeat(32) }), /读取失败|error|摘要/);
  // 同一损坏目录用全新登记表再登记：同样拒绝，不把无法读当作干净可登记。
  const service2 = newService(tempDir("se-branch-statusfail2-"));
  await assert.rejects(() => service2.registerAncestor({ label: "", gitRoot: repo }), /读取失败/);
  // 分支副本同一规则：独立 clone 损坏索引后拒绝登记。
  const cloneDir = tempDir("se-statusfail-clone-");
  git(["clone", "-q", "-b", "main", repo, path.join(cloneDir, "copy")], cloneDir);
  git(["checkout", "-q", "-b", "innovation/statusfail"], path.join(cloneDir, "copy"));
  fs.writeFileSync(path.join(cloneDir, "copy", ".git", "index"), "corrupt-index-fixture-payload-not-a-git-index");
  // 祖先用健康新仓（损坏索引的 repo 自己此时已不可登记，正是上面断言的行为）。
  const healthyAncestor = makeRepo("statusfail-healthy-ancestor");
  const service3 = newService(tempDir("se-branch-statusfail3-"));
  const ancestor3 = await service3.registerAncestor({ label: "", gitRoot: healthyAncestor });
  await assert.rejects(() => service3.registerBranch({ ancestorId: ancestor3.id, label: "", workspaceRoot: path.join(cloneDir, "copy") }), /读取失败/);
  // 读取失败路径不得触碰仓库：损坏索引后 rev-parse/branch 仍可读且与登记前一致。
  assert.equal(git(["rev-parse", "HEAD"], repo).trim(), before.head, "读取失败路径不得移动任何提交");
  assert.equal(git(["branch", "--list", "--format=%(refname:short)"], repo).trim(), before.branches);
});

// —— 块C3：HEAD↔已验 manifest 精确绑定（真实提交树 blob 字节比较；执行器另以假帧覆盖失败类别）——
const binding = require("../../dist/project/BranchHeadBinding.js");
const scopeHost = require("../../dist/extension/PlanCodeScopeHost.js");
const crypto = require("node:crypto");

function manifestFor(repo, files, overrides = {}) {
  const manifest = {};
  for (const rel of files) {
    const bytes = overrides[rel] !== undefined ? (Buffer.isBuffer(overrides[rel]) ? overrides[rel] : Buffer.from(overrides[rel], "utf8"))
      : fs.readFileSync(path.join(repo, ...rel.split("/")));
    manifest[rel] = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  return { digest: scopeHost.planExecutionSourceDigest(manifest), manifest };
}

test("C3 当前提交树逐文件 blob 字节核对：忽略/未跟踪依赖=无法证明此 HEAD；改动/删除如实分类；dirty→clean 可复用", async () => {
  const repo = makeRepo("bind");
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.mkdirSync(path.join(repo, "experiments"), { recursive: true });
  fs.writeFileSync(path.join(repo, "experiments", "a.yaml"), "jobs: 1\n", "utf8");
  fs.writeFileSync(path.join(repo, "pkg", "model.py"), "w = 1\n", "utf8");
  commitFile(repo, "pkg/model.py", "w = 1\n", "add plan and model"); // git add -A 一并提交 experiments/a.yaml
  fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n", "utf8");
  commitFile(repo, ".gitignore", "vendor/\n", "ignore vendor");
  fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(repo, "vendor", "dep.bin"), Buffer.from([0, 1, 2, 253, 254, 255]));
  const head = git(["rev-parse", "HEAD"], repo).trim();
  const planFile = "experiments/a.yaml";
  const revisionOf = source => source.manifest[planFile]?.sha256;
  // ① 提交内文件逐一一致 → ok（含 .gitignore 也是提交树内普通文件）
  const good = manifestFor(repo, [planFile, "pkg/model.py", "tracked.txt"]);
  let result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head,
    executionSource: good, planFile, revision: revisionOf(good) });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.coveredFiles, 3);
  assert.match(result.note, /不构成整仓或科研结论等价/, "覆盖范围必须如实声明");
  // ② manifest 含被忽略的磁盘依赖：不在提交树 → 无法证明；不产生任何写入
  const stateBefore = snapshotRepoState(repo);
  const withIgnored = manifestFor(repo, [planFile, "pkg/model.py", "vendor/dep.bin"]);
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head,
    executionSource: withIgnored, planFile, revision: revisionOf(withIgnored) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /无法证明此 HEAD/);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].path, "vendor/dep.bin");
  assert.match(result.failures[0].reason, /不在当前提交树中/);
  assert.deepEqual(snapshotRepoState(repo), stateBefore, "绑定核对纯只读：不 stage、不 commit、不动工作树");
  // ③ 已验 manifest 的字节与提交 blob 不一致（验证后又改了代码）→ 内容 SHA 不一致
  fs.writeFileSync(path.join(repo, "pkg", "model.py"), "w = 2\n", "utf8");
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head,
    executionSource: good, planFile, revision: revisionOf(good) });
  assert.equal(result.ok, true, "工作树改动不影响“提交树=已验清单”的证明（dirty 注记由调用方按身份探针补）");
  const staleManifest = manifestFor(repo, [planFile, "pkg/model.py"], { "pkg/model.py": "w = 3\n" });
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head,
    executionSource: staleManifest, planFile, revision: revisionOf(staleManifest) });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, "内容 SHA 与已验清单不一致");
  // ④ 提交里删除 manifest 内文件 → 不在当前提交树
  git(["rm", "--cached", "-q", "-f", "--", "pkg/model.py"], repo); // 仅从提交索引移除，保留磁盘原字节
  assert.equal(fs.readFileSync(path.join(repo, "pkg/model.py"), "utf8"), "w = 2\n", "缺失 blob 场景不删除夹具文件");
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "-m", "drop model"], repo);
  const head2 = git(["rev-parse", "HEAD"], repo).trim();
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head2,
    executionSource: good, planFile, revision: revisionOf(good) });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].path, "pkg/model.py");
  assert.match(result.failures[0].reason, /不在当前提交树中/);
  // ⑤ dirty→clean：把新内容提交后，用“新字节”的 manifest 在新 HEAD 上仍成立（同 blob＝可复用，不重跑科研）
  commitFile(repo, "pkg/model.py", "w = 2\n", "restore model new content");
  const head3 = git(["rev-parse", "HEAD"], repo).trim();
  const renewed = manifestFor(repo, [planFile, "pkg/model.py", "tracked.txt"]);
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head3,
    executionSource: renewed, planFile, revision: revisionOf(renewed) });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  // ⑥ 非完整 SHA/不存在的提交/篡改摘要/revision 漂移/非法路径：全部失败关闭
  // Git 对“有效 40SHA+8 零”的 48 位串可能 exit0 解析回原提交（宿主 274 只读实证）——精确身份必须
  // 自己把关：绑定入口先拒格式，拒之前不得发起任何 Git 调用；不存在的对象经 ^{commit} 解引用真实拦停。
  const callsOf = [];
  const recordingRunner = async (args, cwdArg, stdin) => { callsOf.push(args.join(" ")); return binding.runGitBinary(args, cwdArg, stdin); };
  result = await binding.bindPlanSourceToCommit({ runner: recordingRunner, cwd: repo, headCommit: head3 + "00000000",
    executionSource: renewed, planFile, revision: revisionOf(renewed) });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].reason, /完整 40 位/);
  assert.deepEqual(callsOf, [], "格式拒绝之前零子进程：不得借 Git 的宽容解析蒙混");
  callsOf.length = 0;
  result = await binding.bindPlanSourceToCommit({ runner: recordingRunner, cwd: repo, headCommit: "0".repeat(40),
    executionSource: renewed, planFile, revision: revisionOf(renewed) });
  assert.equal(result.ok, false, "40 个零＝格式合法但对象真实不存在，必须按不存在/不可读失败");
  assert.match(result.failures[0].reason, /不存在或不可读/);
  assert.ok(callsOf.some(line => line === `rev-parse --verify --quiet ${"0".repeat(40)}^{commit}`), JSON.stringify(callsOf));
  callsOf.length = 0;
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head3,
    executionSource: { ...renewed, digest: "0".repeat(64) }, planFile, revision: revisionOf(renewed) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /摘要自校验失败/);
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head3,
    executionSource: renewed, planFile, revision: "f".repeat(64) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /revision 不一致/);
  const badPath = manifestFor(repo, [planFile]);
  badPath.manifest["../escape.py"] = { size: 1, sha256: "0".repeat(64) };
  badPath.digest = scopeHost.planExecutionSourceDigest(badPath.manifest);
  result = await binding.bindPlanSourceToCommit({ runner: binding.runGitBinary, cwd: repo, headCommit: head3,
    executionSource: badPath, planFile, revision: revisionOf(badPath) });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].reason, /相对路径规则/);
});

test("C3 假执行器：ls-tree 符号链接/缺路径与 cat-file 帧缺失/非 blob 均如实归类，绝不打印 blob 内容", async () => {
  const sha = text => crypto.createHash("sha256").update(text).digest("hex");
  const manifest = { "a.py": { size: 2, sha256: sha("x\n") },
    "link.py": { size: 1, sha256: sha("l") },
    "gone.py": { size: 1, sha256: sha("g") },
    "sub/dir.py": { size: 1, sha256: sha("s") },
    "treeish.py": { size: 1, sha256: sha("t") } };
  const okOid = "1111111111111111111111111111111111111111";
  const linkOid = "2222222222222222222222222222222222222222";
  const goneOid = "3333333333333333333333333333333333333333";
  const treeOid = "4444444444444444444444444444444444444444";
  const listing = ["100644 blob " + okOid + "\ta.py", "120000 blob " + linkOid + "\tlink.py",
    "100644 blob " + goneOid + "\tgone.py", "160000 commit " + treeOid + "\tsub",
    "100644 blob " + treeOid + "\ttreeish.py"].join("\0") + "\0";
  // cat-file --batch 帧按请求顺序返回（请求顺序＝manifest 键序过滤后的 a, gone, treeish）
  const batch = Buffer.concat([
    Buffer.from(okOid + " blob 2\n"), Buffer.from("x\n"), Buffer.from("\n"),
    Buffer.from(goneOid + " missing\n"),
    Buffer.from(treeOid + " tree 0\n\n"),
  ]);
  const requested = [];
  const revRequests = [];
  const runner = async (args, _cwd, stdin) => {
    if (args[0] === "rev-parse") { revRequests.push(args.join(" ")); return { code: 0, stdout: Buffer.from("c".repeat(40) + "\n"), stderr: "" }; } // 已知完整 commit 常量：满足解析往返
    if (args[0] === "ls-tree") return { code: 0, stdout: Buffer.from(listing, "utf8"), stderr: "" };
    if (args[0] === "cat-file") { requested.push(String(stdin)); return { code: 0, stdout: batch, stderr: "" }; }
    throw new Error("unexpected " + args.join(" "));
  };
  const result = await binding.verifyCommitTreeAgainstManifest({ runner, cwd: "/fixture", commit: "c".repeat(40), manifest });
  assert.deepEqual(revRequests, ["rev-parse --verify --quiet " + "c".repeat(40) + "^{commit}"], "唯一一次提交核验＝规范化完整 SHA 的 ^{commit} 精确请求");
  assert.equal(result.ok, false);
  assert.equal(result.coveredFiles, 1, "唯一逐字节一致的文件");
  assert.equal(requested.length, 1, "≤300 个对象单批读取");
  const byPath = new Map(result.failures.map(row => [row.path, row.reason]));
  assert.match(byPath.get("link.py"), /符号链接/);
  assert.match(byPath.get("gone.py"), /对象库中缺失/);
  assert.match(byPath.get("treeish.py"), /不是 blob/);
  assert.match(byPath.get("sub/dir.py"), /不在当前提交树中/);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(JSON.stringify("x\n")), "失败信息不得携带 blob 内容");
  // 截断帧：声明大小但字节不足 → 全部剩余帧按未知处理，不得判为一致
  const truncRunner = async (args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: Buffer.from("c".repeat(40) + "\n"), stderr: "" };
    if (args[0] === "ls-tree") return { code: 0, stdout: Buffer.from("100644 blob " + okOid + "\ta.py\0", "utf8"), stderr: "" };
    return { code: 0, stdout: Buffer.from(okOid + " blob 9\nx\n"), stderr: "" };
  };
  const truncated = await binding.verifyCommitTreeAgainstManifest({ runner: truncRunner, cwd: "/fixture", commit: "c".repeat(40), manifest: { "a.py": manifest["a.py"] } });
  assert.equal(truncated.ok, false);
  assert.match(truncated.failures[0].reason, /帧解析失败/);
});

// —— 块C4/C5：科研仓 PR 适配（真实 gh 2.93 argv 形态；注入执行器；祖先快进用真实临时仓）——
const pr = require("../../dist/project/BranchPullRequest.js");

function buf(text) { return Buffer.from(String(text), "utf8"); }
function jsonBuf(value) { return buf(JSON.stringify(value)); }
function recordingGit(script) {
  const calls = [];
  const runner = async (args, cwd, stdin) => {
    const line = args.join(" ");
    calls.push({ args: line, cwd, stdin });
    for (const row of script) {
      if (!row.match.test(line)) continue;
      if (row.uses !== undefined) { row.used = (row.used || 0) + 1; if (row.used > row.uses) continue; }
      if (row.throw) throw new Error(row.throw);
      return { code: row.code ?? 0, stdout: buf(row.stdout ?? ""), stderr: row.stderr ?? "" };
    }
    throw new Error("unexpected git args: " + line);
  };
  return { runner, calls };
}
function memoryLedger(initial = []) {
  let rows = [...initial];
  return { load: async () => rows.map(row => ({ ...row })), save: async next => { rows = next; }, rows: () => rows };
}
const FULL_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const OTHER_SHA = "e".repeat(40);
const MERGE_SHA = "c".repeat(40);
const SELECTOR = "github.com/org/repo";
const PR_OPTS = { cwd: "/repo", remoteName: "origin", registeredRemoteUrl: "https://github.com/org/repo.git", branch: "exp/m1", base: "main", sourceSha: FULL_SHA };
// gh 2.93 真实对象形状（主控实读本插件 PR#12 exit0 输出）：headRepositoryOwner/headRepository 是对象。
const PR_OPEN = (over = {}) => ({ number: 21, state: "OPEN", headRefOid: FULL_SHA, headRefName: "exp/m1",
  headRepository: { id: "R_kgDOT", name: "repo", nameWithOwner: "org/repo" }, headRepositoryOwner: { id: "U_kgDOB", login: "org" },
  baseRefOid: BASE_SHA, baseRefName: "main", url: "https://github.com/org/repo/pull/21", ...over });
const PR_VIEW = (over = {}) => {
  const number = over.number ?? 21; // view DTO 必须携带请求字段里的 number（缺失会被 verifyPrIdentity 正当拒绝）
  return { state: "OPEN", mergedAt: null, mergeCommit: null, headRefOid: FULL_SHA, headRefName: "exp/m1",
    headRepository: { id: "R_kgDOT", name: "repo", nameWithOwner: "org/repo" }, headRepositoryOwner: { id: "U_kgDOB", login: "org" },
    baseRefOid: BASE_SHA, baseRefName: "main", ...over, number, url: over.url || `https://github.com/org/repo/pull/${number}` };
};
// 只读预览标准脚本：远端 main 存在、exp/m1 不存在、无基线引用、gh 列表为空。
function baseScript(listRows) {
  return [
    { match: /^remote get-url/, stdout: "https://github.com/org/repo.git\n" },
    { match: /^ls-remote --heads origin main$/, stdout: BASE_SHA + "\trefs/heads/main\n" },
    { match: /^ls-remote --heads origin exp\//, stdout: "" },
    { match: /^rev-list/, code: 128, stderr: "unknown revision" },
    { match: /^pr list/, stdout: jsonBuf(listRows ?? []) },
  ];
}
async function previewOf(script, ghRows) {
  // 预览的 pr list 走 gh 执行器；未显式给 ghRows 时取脚本里的 pr list 行，保证与 create 内部预览一致
  if (ghRows === undefined) {
    const row = script.find(r => r.match.source.startsWith("^pr list"));
    ghRows = row ? JSON.parse(String(row.stdout)) : [];
  }
  return pr.previewBranchPullRequest({ git: recordingGit(script).runner, gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf(ghRows) }]).runner, ...PR_OPTS });
}

test("C4 normalizeGithubTarget：只剥 .git 后缀、仅 GitHub 两段仓库、ssh 端口解析、凭证/异平台拒绝", () => {
  assert.deepEqual(pr.normalizeGithubTarget("https://github.com/org/repo.git"), { host: "github.com", owner: "org", repo: "repo", repoSelector: "github.com/org/repo", displayUrl: "https://github.com/org/repo" });
  assert.equal(pr.normalizeGithubTarget("git@github.com:org/repo.git").repo, "repo", "scp 式 .git 只剥后缀，整段不能被吞掉");
  assert.equal(pr.normalizeGithubTarget("ssh://git@github.com:7999/org/repo.git"), undefined, "非默认/未知端口不得忽略后冒称标准 GitHub 端点");
  assert.equal(pr.normalizeGithubTarget("ssh://git:password@github.com/org/repo.git"), undefined, "ssh URL 显式 password 同样拒绝；登录名 git 本身没问题");
  assert.equal(pr.normalizeGithubTarget("https://ghp_tokenUser@github.com/org/repo.git"), undefined, "https 用户名（token 形态）拒绝");
  assert.equal(pr.normalizeGithubTarget("ssh://git@github.com/org/repo.git").repoSelector, SELECTOR, "默认 22 端口 ssh 登录名是正常形态");
  assert.equal(pr.normalizeGithubTarget("https://github.com/org/repo").displayUrl, "https://github.com/org/repo");
  assert.equal(pr.normalizeGithubTarget("https://tok:pw@github.com/org/repo"), undefined, "含凭证 https：拒绝");
  assert.equal(pr.normalizeGithubTarget("https://github.com:8443/org/repo"), undefined, "https 非默认端口拒绝");
  assert.equal(pr.normalizeGithubTarget("https://gitlab.internal/team/sub/project"), undefined, "非 GitHub 托管：明确拒绝，不重定向");
  assert.equal(pr.normalizeGithubTarget("https://github.com/team/sub/project"), undefined, "GitHub 仓库是 owner/repo 两段，不冒充多层组");
  assert.equal(pr.normalizeGithubTarget("https://github.com/org"), undefined);
  assert.equal(pr.normalizeGithubTarget("not a url"), undefined);
});

test("C4 preview：gh 必须带完整 --repo 选择器与 state=all；漂移/登记不可规范化/截断/他分支/大小写全部如实", async () => {
  const gh = recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]);
  const preview = await pr.previewBranchPullRequest({ git: recordingGit(baseScript()).runner, gh: gh.runner, ...PR_OPTS });
  assert.equal(preview.ok, true);
  const listArgs = gh.calls[0].args;
  assert.ok(listArgs.includes("--repo " + SELECTOR), "必须显式 host 选择器，防 GH_HOST 默认重定向: " + listArgs);
  assert.ok(listArgs.includes("--state all"), "必须覆盖 open/merged（网页已合并的恢复依赖）");
  assert.equal(preview.existing.kind, "none");
  // 有效推送目标：fetch 同仓但 push 异仓/多目标/未知形态全部拒绝（pushurl/pushInsteadOf 契约缺口反例）
  let pPush = await pr.previewBranchPullRequest({ git: recordingGit([
    { match: /^remote get-url --push/, stdout: "https://github.com/org/other.git\n" },
    ...baseScript(),
  ]).runner, gh: gh.runner, ...PR_OPTS });
  assert.equal(pPush.ok, false, "fetch A 而 push B：确认后写 B 的契约缺口必须拒绝");
  assert.match(pPush.reason, /与已确认仓库不一致/);
  pPush = await pr.previewBranchPullRequest({ git: recordingGit([
    { match: /^remote get-url --push/, stdout: "https://github.com/org/repo.git\nhttps://github.com/org/second.git\n" },
    ...baseScript(),
  ]).runner, gh: gh.runner, ...PR_OPTS });
  assert.equal(pPush.ok, false);
  assert.match(pPush.reason, /个不同仓库/);
  pPush = await pr.previewBranchPullRequest({ git: recordingGit([
    { match: /^remote get-url --push/, stdout: "https://tok-secret@github.com/org/repo.git\n" },
    ...baseScript(),
  ]).runner, gh: gh.runner, ...PR_OPTS });
  assert.equal(pPush.ok, false);
  assert.ok(!pPush.reason.includes("tok-secret"), "未知推送目标的错误绝不回显 raw URI: " + pPush.reason);
  // 登记 URL 不可规范化：不允许跳过漂移校验
  let p2 = await pr.previewBranchPullRequest({ git: recordingGit(baseScript()).runner, gh: gh.runner, ...PR_OPTS, registeredRemoteUrl: "https://gitlab.internal/org/repo.git" });
  assert.equal(p2.ok, false);
  assert.match(p2.reason, /登记祖先的 origin 无法规范化/);
  // 真实祖先与分支 origin 不同仓
  p2 = await pr.previewBranchPullRequest({ git: recordingGit(baseScript()).runner, gh: gh.runner, ...PR_OPTS, registeredRemoteUrl: "https://github.com/org/other.git" });
  assert.equal(p2.ok, false);
  assert.match(p2.reason, /不是同一已确认仓库/);
  // 分类契约：classifyPrRows 吃 parsePrList/toPrRow 规范化后的行；stub 必须是原始 GH 对象并走真实解析管道
  const classifyRaw = (rawRows, truncated, options) => pr.classifyPrRows(pr.parsePrList(JSON.stringify(rawRows)), truncated, options);
  // 截断＝unknown，不得假唯一/不存在
  const many = Array.from({ length: 200 }, (_, i) => PR_OPEN({ number: 1000 + i, headRefOid: OTHER_SHA }));
  let classified = classifyRaw(many, true, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "unknown");
  // 同 base 他分支的“其它创新 PR”/fork PR/同 SHA 他分支：都不得当本分支 PR
  classified = classifyRaw([PR_OPEN({ headRefName: "exp/other" })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "none");
  assert.match(classified.note, /其它创新 PR|没有任何 PR/);
  classified = classifyRaw([PR_OPEN({ headRepositoryOwner: { id: "U_x", login: "forker" }, headRepository: { nameWithOwner: "forker/repo" } })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "none", "fork 的 headRefName 相同也不属于本仓分支");
  classified = classifyRaw([PR_OPEN({ headRefName: "exp/other" })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.notEqual(classified.kind, "reuse");
  // Git 引用（head 分支与 base）大小写一律敏感；仅 owner/repo 与 SHA 不敏感
  classified = classifyRaw([PR_OPEN({ headRefName: "Exp/M1" })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "none", "head 引用名大小写敏感");
  classified = classifyRaw([PR_OPEN({ baseRefName: "Main" })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "none", "base 引用名同样大小写敏感");
  classified = classifyRaw([PR_OPEN({ headRepository: { nameWithOwner: "ORG/REPO" }, headRepositoryOwner: { login: "ORG" } })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "reuse", "GitHub owner/repo 身份不敏感");
  // 同分支旧 MERGED 但 SHA 不同：只是历史提示，当前新 SHA 仍可开新 PR
  classified = classifyRaw([PR_OPEN({ state: "MERGED", number: 9, headRefOid: OTHER_SHA })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "none");
  assert.match(classified.note, /历史 MERGED PR（另一候选）/);
  classified = classifyRaw([PR_OPEN({ state: "MERGED", number: 9 })], false, { owner: "org", repo: "repo", branch: "exp/m1", base: "main", sourceSha: FULL_SHA });
  assert.equal(classified.kind, "merged", "完整候选身份全匹配的 MERGED 才是已合");
});

test("C4 create：真实 gh 2.93 argv（pr create 无 --json）、写前本地 HEAD 复核、身份 view 核验", async () => {
  const ledger = memoryLedger();
  const preview0 = await previewOf(baseScript());
  const git3 = recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^ls-remote --heads origin exp\//, stdout: "", uses: 1 }, // 预览+登记期读空（preview 内一次 + 写前复核一次）
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    ...baseScript(),
  ]);
  const gh3 = recordingGit([
    { match: /^pr list/, stdout: jsonBuf([]) },
    { match: /^pr create/, stdout: "Creating pull request for exp/m1 into main\n\nhttps://github.com/org/repo/pull/12\n" },
    { match: /^pr view 12/, stdout: jsonBuf(PR_OPEN({ number: 12 })) },
  ]);
  const preview3 = await pr.previewBranchPullRequest({ git: recordingGit(baseScript()).runner, gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]).runner, ...PR_OPTS });
  let result = await pr.createBranchPullRequest({ git: git3.runner, gh: gh3.runner, ledger, ...PR_OPTS, title: "t", body: "b", previewDigest: preview3.digest });
  assert.equal(result.status, "created", JSON.stringify(result));
  const createCall = gh3.calls.find(call => call.args.startsWith("pr create"));
  assert.ok(!/--json/.test(createCall.args), "gh 2.93 pr create 无 --json，虚构 flag 必被执行器拒绝: " + createCall.args);
  const pushCall = git3.calls.find(call => call.args.startsWith("push"));
  assert.equal(pushCall.args, "push origin " + FULL_SHA + ":refs/heads/exp/m1", "确认后 immutable SHA，非符号分支引用");
  assert.ok(gh3.calls.some(call => call.args.startsWith("pr view 12")), "创建后必须只读 view 核验身份");
  assert.equal(ledger.rows().filter(row => row.outcome === "ok").length, 2, "push 与 pr-create 各自独立收据");
  // view 身份不符 → 不宣称成功（独立 ledger：不得把本场景的 unknown 泄漏给后续独立场景）
  const ledgerView = memoryLedger();
  const gh4 = recordingGit([
    { match: /^pr list/, stdout: jsonBuf([]) },
    { match: /^pr create/, stdout: "https://github.com/org/repo/pull/13\n" },
    { match: /^pr view 13/, stdout: jsonBuf(PR_VIEW({ number: 13, headRefOid: OTHER_SHA })) },
  ]);
  result = await pr.createBranchPullRequest({ git: recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^ls-remote --heads origin exp\//, stdout: "", uses: 1 },
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    ...baseScript(),
  ]).runner, gh: gh4.runner, ledger: ledgerView, ...PR_OPTS, title: "t", body: "b", previewDigest: preview3.digest });
  assert.equal(result.status, "blocked-unknown", JSON.stringify(result));
  assert.ok(ledgerView.rows().some(row => row.action === "pr-create" && row.outcome === "unknown"), "身份核验失败必须留 unknown 收据不假成功");
  // 确认后本地 HEAD 变化 → 零写入（全新 ledger：独立场景独立状态）
  const git5 = recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: OTHER_SHA + "\n" },
    ...baseScript(),
  ]);
  result = await pr.createBranchPullRequest({ git: git5.runner, gh: gh3.runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: preview3.digest });
  assert.equal(result.status, "blocked-unknown");
  assert.match(result.reason, /本地分支/);
  assert.equal(git5.calls.filter(call => call.args.startsWith("push")).length, 0, "确认后新变未验提交绝不代推");
  // updates-existing：确认后普通推送更新既有 PR → 只读重查复用；绝不 pr create
  const rows21 = [PR_OPEN({ number: 21, headRefOid: OTHER_SHA })];
  const preview6 = await previewOf(baseScript(rows21));
  assert.equal(preview6.existing.kind, "updates-existing");
  const git6 = recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^ls-remote --heads origin exp\//, stdout: "", uses: 1 },
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    ...baseScript(rows21),
  ]);
  const gh6 = recordingGit([
    { match: /^pr list/, stdout: jsonBuf(rows21) },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ number: 21 })) },
  ]);
  result = await pr.createBranchPullRequest({ git: git6.runner, gh: gh6.runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: preview6.digest });
  assert.equal(result.status, "reused", JSON.stringify(result));
  assert.equal(gh6.calls.filter(call => call.args.startsWith("pr create")).length, 0, "同 source/base 已确证开放 PR 不得盲 create");
});

test("C4/R4 写前推送目标在确认后变化 → 零写入；真实 Git 配置（pushurl/pushInsteadOf）由 get-url --push --all 只读展开", async () => {
  const previewScript = [{ match: /^remote get-url --push/, stdout: "https://github.com/org/repo.git\n", uses: 1 }, { match: /^remote get-url --push/, stdout: "https://github.com/org/other.git\n" }, ...baseScript()];
  const preview = await pr.previewBranchPullRequest({ git: recordingGit([{ match: /^remote get-url --push/, stdout: "https://github.com/org/repo.git\n" }, ...baseScript()]).runner,
    gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]).runner, ...PR_OPTS });
  assert.equal(preview.ok, true);
  const gitX = recordingGit([
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    { match: /^push/, stdout: "MUST NOT PUSH" },
    ...previewScript,
  ]);
  const result = await pr.createBranchPullRequest({ git: gitX.runner, gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]).runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: preview.digest });
  assert.equal(result.status, "blocked-unknown", JSON.stringify(result));
  assert.match(result.reason, /推送目标/);
  assert.equal(gitX.calls.filter(call => call.args.startsWith("push")).length, 0);
  // —— 真实临时 Git 配置：只读 get-url 证明解析，绝不联网、绝不真的 push ——
  const cfg = makeRepo("pushurl");
  git(["remote", "add", "origin", "https://github.com/org/repo.git"], cfg);
  const confirmed = pr.normalizeGithubTarget("https://github.com/org/repo.git");
  let resolved = await pr.resolveConfirmedPushTargets(pr.runGitPullRequest, cfg, "origin", confirmed);
  assert.equal(resolved.ok, true, "默认无 pushurl 时写目标=已确认仓");
  git(["config", "remote.origin.pushurl", "https://github.com/org/other.git"], cfg);
  resolved = await pr.resolveConfirmedPushTargets(pr.runGitPullRequest, cfg, "origin", confirmed);
  assert.equal(resolved.ok, false, "pushurl 指向异仓必须被展开发现");
  assert.match(resolved.reason, /与已确认仓库不一致/);
  git(["config", "remote.origin.pushurl", "git@github.com:ORG/REPO.git"], cfg);
  resolved = await pr.resolveConfirmedPushTargets(pr.runGitPullRequest, cfg, "origin", confirmed);
  assert.equal(resolved.ok, true, "同仓大小写差异的 scp pushurl 是正常形态");
  git(["config", "remote.origin.pushurl", "https://github.com/org/other.git"], cfg);
  git(["config", "url.https://evil.example/org/repo.git.pushInsteadOf", "https://github.com/org/other.git"], cfg);
  resolved = await pr.resolveConfirmedPushTargets(pr.runGitPullRequest, cfg, "origin", confirmed);
  assert.equal(resolved.ok, false, "无论该 Git 版本是否在 get-url 阶段应用 pushInsteadOf，异写目标（异仓或异主机）都必须拒绝");
});

test("C5 未知结果不可重放：每动作独立收据、unknown 只读对账、MERGED 只读恢复、账本不吞未对账", async () => {
  const keyPush = pr.receiptKey(["/repo", "exp/m1", FULL_SHA, "main"], "push", SELECTOR);
  const keyPr = pr.receiptKey(["/repo", "exp/m1", FULL_SHA, "main"], "pr-create", SELECTOR);
  const unknown = (key, action) => ({ key, root: "/repo", branch: "exp/m1", sourceSha: FULL_SHA, base: "main", repoSelector: SELECTOR, action, attemptAt: "2026-10-25T00:00:00Z", outcome: "unknown" });
  // push unknown + 远端头不符 → blocked 且不重推
  const ledgerA = memoryLedger([unknown(keyPush, "push")]);
  const gitA = recordingGit([{ match: /^push/, stdout: "" }, ...baseScript()]);
  const ghEmpty = recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]);
  const preview0 = await previewOf(baseScript());
  let result = await pr.createBranchPullRequest({ git: gitA.runner, gh: ghEmpty.runner, ledger: ledgerA, ...PR_OPTS, title: "t", body: "b", previewDigest: preview0.digest });
  assert.equal(result.status, "blocked-unknown");
  assert.equal(gitA.calls.filter(call => call.args.startsWith("push")).length, 0, "未能确证 push 落地/未落地时绝不重发");
  // push unknown + 远端恰等源 SHA → 对账结清，只补做 PR 步骤（仍零 push）
  const gitB = recordingGit([
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    { match: /^push/, stdout: "SHOULD NOT PUSH" },
    ...baseScript().map(row => row.match.source.includes("main") || row.match.source.includes("remote") || row.match.source.includes("rev-list") ? row : null).filter(Boolean),
  ]);
  const ghB = recordingGit([
    { match: /^pr list/, stdout: jsonBuf([]), uses: 2 },
    { match: /^pr create/, stdout: "https://github.com/org/repo/pull/31\n" },
    { match: /^pr view 31/, stdout: jsonBuf(PR_VIEW({ number: 31 })) },
  ]);
  const ledgerB = memoryLedger([unknown(keyPush, "push")]);
  const previewB = await pr.previewBranchPullRequest({ git: recordingGit(gitBScript()).runner, gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]).runner, ...PR_OPTS });
  result = await pr.createBranchPullRequest({ git: gitB.runner, gh: ghB.runner, ledger: ledgerB, ...PR_OPTS, title: "t", body: "b", previewDigest: previewB.digest });
  assert.equal(result.status, "created", JSON.stringify(result));
  assert.equal(gitB.calls.filter(call => call.args.startsWith("push")).length, 0, "对账证明已落地 → 不重推");
  assert.ok(ledgerB.rows().find(row => row.key === keyPush && row.outcome === "ok"), "对账成功才把 unknown 结清");
  // pr-create unknown + 对账发现精确 PR → reused，零 create
  const rows32 = [PR_OPEN({ number: 32 })];
  const ledgerC = memoryLedger([unknown(keyPr, "pr-create")]);
  const ghC = recordingGit([{ match: /^pr list/, stdout: jsonBuf(rows32) }]);
  const gitC = recordingGit(baseScript(rows32));
  const previewC = await previewOf(baseScript(rows32));
  result = await pr.createBranchPullRequest({ git: gitC.runner, gh: ghC.runner, ledger: ledgerC, ...PR_OPTS, title: "t", body: "b", previewDigest: previewC.digest });
  assert.equal(result.status, "reused");
  assert.equal(ghC.calls.filter(call => call.args.startsWith("pr create")).length, 0);
  // merge：unknown 收据 + view 仍 OPEN → 不重发；view MERGED → 只读恢复且结清
  const keyMerge = pr.mergeReceiptKey(SELECTOR, 21, FULL_SHA);
  const ledgerD = memoryLedger([unknown(keyMerge, "merge")]);
  const ghD = recordingGit([
    { match: /^pr merge/, stdout: "SHOULD NOT MERGE" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW()) },
  ]);
  result = await pr.mergeBranchPullRequest({ gh: ghD.runner, ledger: ledgerD, cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(result.status, "blocked-unknown");
  assert.equal(ghD.calls.filter(call => call.args.startsWith("pr merge")).length, 0, "merge 有未对账收据时绝不重发");
  const ghE = recordingGit([
    { match: /^pr merge/, stdout: "SHOULD NOT MERGE" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA } })) },
  ]);
  const ledgerE = memoryLedger([unknown(keyMerge, "merge")]);
  result = await pr.mergeBranchPullRequest({ gh: ghE.runner, ledger: ledgerE, cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(result.status, "merged", "网页/上次未知操作已 MERGED：只读恢复，不重发");
  assert.equal(ghE.calls.filter(call => call.args.startsWith("pr merge")).length, 0);
  assert.ok(ledgerE.rows().find(row => row.key === keyMerge && row.outcome === "ok"));
  // 正常 merge：写前重查完整身份；--merge+--match-head；退出码不作结论
  const ghF = recordingGit([
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW()), uses: 1 },
    { match: /^pr merge/, code: 1, stderr: "post-merge hook failed" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA } })) },
  ]);
  result = await pr.mergeBranchPullRequest({ gh: ghF.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(result.status, "merged");
  assert.equal(result.mergeCommit, MERGE_SHA);
  assert.ok(ghF.calls.find(call => call.args.startsWith("pr merge")).args.includes("--match-head-commit " + FULL_SHA));
  // 身份漂移（head 分支不同/网页改了 base）→ 零写
  const ghG = recordingGit([{ match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ headRefName: "exp/renamed" })) }]);
  result = await pr.mergeBranchPullRequest({ gh: ghG.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(result.status, "blocked-unknown");
  assert.equal(ghG.calls.filter(call => call.args.startsWith("pr merge")).length, 0);
  // pr-create unknown + updates-existing（同分支不同 SHA 的开放 PR）：拒绝，不 settle 不假复用
  const rows21 = [PR_OPEN({ number: 21, headRefOid: OTHER_SHA })]; // 本测试就地构造，不借其它测试局部变量
  const ledgerH = memoryLedger([unknown(keyPr, "pr-create")]);
  const gitH = recordingGit(baseScript(rows21));
  const ghH1 = recordingGit([{ match: /^pr list/, stdout: jsonBuf(rows21) }]);
  result = await pr.createBranchPullRequest({ git: gitH.runner, gh: ghH1.runner, ledger: ledgerH, ...PR_OPTS, title: "t", body: "b", previewDigest: (await previewOf(baseScript(rows21))).digest });
  assert.equal(result.status, "blocked-unknown", "updates-existing 不能被视为 pr-create 收据已落地");
  assert.match(result.reason, /不重发、不假复用/, "必须走 prUnknown 拒绝路径而非 digest 不符");
  assert.ok(ledgerH.rows().some(row => row.key === keyPr && row.outcome === "unknown"), "拒绝时保留未对账收据");
  // merge：MERGED 但身份属另一候选 → 不得当作本候选已合并
  const ghH2 = recordingGit([
    { match: /^pr merge/, stdout: "SHOULD NOT MERGE" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA }, headRefOid: OTHER_SHA })) },
  ]);
  result = await pr.mergeBranchPullRequest({ gh: ghH2.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(result.status, "blocked-unknown", "另一个候选的 MERGED 事实不能冒充本候选");
  assert.equal(ghH2.calls.filter(call => call.args.startsWith("pr merge")).length, 0);
  // 修剪策略：未对账 unknown 永不清除，已结只留最近 200
  const flooded = pr.pruneReceipts([
    ...Array.from({ length: 250 }, (_, i) => ({ key: "k" + i, outcome: "ok", action: "push" })),
    { key: "pending", outcome: "unknown", action: "pr-create" },
  ]);
  assert.ok(flooded.some(row => row.key === "pending"), "截断历史不得吞掉未对账收据");
  assert.equal(flooded.filter(row => row.outcome === "ok").length, 200);
});

function gitBScript() {
  return [
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    { match: /^remote get-url/, stdout: "https://github.com/org/repo.git\n" },
    { match: /^ls-remote --heads origin main$/, stdout: BASE_SHA + "\trefs/heads/main\n" },
    { match: /^rev-list/, code: 128, stderr: "unknown revision" },
  ];
}

// User-approved 2026-10-28: preserve every assertion while separating the old 30s
// composite scenario into isolated <=20s groups. No timeout retries or wider limits.
async function ancestorFfWorld() {
  const originDir = tempDir("se-pr-origin-");
  git(["init", "-q", "--bare", "-b", "main", originDir], originDir);
  const seed = tempDir("se-pr-seed-");
  const dirA = tempDir("se-pr-A-"); const dirC = tempDir("se-pr-C-");
  git(["clone", "-q", originDir, dirA], seed);
  commitFile(dirA, "tracked.txt", "seed\n", "seed");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirA);
  git(["clone", "-q", originDir, dirC], seed); // 在 seed 落地后克隆：与 dirA 共享历史，避免无关根推送被拒
  const expectedRemoteUrl = git(["remote", "get-url", "origin"], dirA).trim();
  // 身份观测面＝产品同一真实探针（宿主 274 轮只读证实：旧手写 identity 走 gitGitEnv 强加
  // GIT_CONFIG_NOSYSTEM/GIT_ATTR_NOSYSTEM，把系统 core.autocrlf 环境里 ff 正确写出的 CRLF 工作树
  // 误判为脏；产品注入的是 readGitIdentity，与 runGitPullRequest 同 sanitize/process 环境）。
  const identityOf = (dir) => probe.readGitIdentity(dir);
  const ffOptions = (identity, expectedMergeCommit) => ({ git: pr.runGitPullRequest, cwd: dirA, remoteName: "origin", base: "main", expectedMergeCommit, expectedRemoteUrl, readIdentity: identity });
  // 合并提交落地后远端又前进（包含 merge 的后续头）→ 允许 ff 到已核完整 SHA
  commitFile(dirC, "tracked.txt", "merge-landed\n", "merge landed");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirC);
  const mergeSha = git(["rev-parse", "HEAD"], dirC).trim();
  commitFile(dirC, "tracked.txt", "follow-up\n", "follow-up commit after merge");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirC);
  const followSha = git(["rev-parse", "HEAD"], dirC).trim();
  return { dirA, dirC, identityOf, ffOptions, mergeSha, followSha };
}

test("C5 祖先 ff：正常快进包含合并提交的后续头且重复调用幂等", async () => {
  const { dirA, identityOf, ffOptions, mergeSha, followSha } = await ancestorFfWorld();
  let ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  assert.equal(ff.status, "fast-forwarded", JSON.stringify(ff));
  assert.equal(ff.to, followSha.toLowerCase(), "目标=已核完整后续头，而非可漂移符号 ref");
  // 已在主线上
  ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  assert.ok(ff.status === "already-current" || ff.status === "fast-forwarded", "第二次应为无操作/仍一致：" + JSON.stringify(ff));

});

test("C5 祖先 ff：fetch 期间变脏必须阻断", async () => {
  const { dirA, dirC, identityOf, ffOptions, mergeSha, followSha } = await ancestorFfWorld();
  let ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  // fetch 期间本机变脏 → 停（注入探针：第二次读起 dirty）
  fs.writeFileSync(path.join(dirC, "extra.txt"), "y\n", "utf8");
  commitFile(dirC, "extra.txt", "y\n", "remote moves again");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirC);
  const follow2 = git(["rev-parse", "HEAD"], dirC).trim();
  let probes = 0;
  ff = await pr.fastForwardAncestorRoot(ffOptions(() => {
    probes++;
    const real = identityOf(dirA);
    return probes > 2 ? { ...real, dirty: true } : real;
  }, follow2));
  assert.equal(ff.status, "blocked");
  assert.match(ff.reason, /不干净/);

});

test("C5 祖先 ff：缺失合并提交必须阻断", async () => {
  const { dirA, dirC, identityOf, ffOptions, mergeSha, followSha } = await ancestorFfWorld();
  let ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  // 未包含的“合并提交” → 暂缓
  commitFile(dirA, "local-only.txt", "x\n", "local only");
  const localSha = git(["rev-parse", "HEAD"], dirA).trim();
  ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), localSha));
  assert.ok(ff.status === "blocked" && /尚未包含|不是|分叉/.test(ff.reason), JSON.stringify(ff));

});

test("C5 祖先 ff：分叉必须阻断且不切分支", async () => {
  const { dirA, dirC, identityOf, ffOptions, mergeSha, followSha } = await ancestorFfWorld();
  let ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  // 分叉 → blocked 且绝不合并提交
  commitFile(dirA, "tracked.txt", "diverged\n", "diverge locally");
  commitFile(dirC, "tracked.txt", "remote-again\n", "remote again");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirC);
  const remote2 = git(["rev-parse", "HEAD"], dirC).trim();
  ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), remote2));
  assert.equal(ff.status, "blocked");
  assert.match(ff.reason, /祖先|分叉|ff-only/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dirA).trim(), "main", "绝不切分支");

});

test("C5 祖先 ff：origin 漂移必须在 fetch 前阻断", async () => {
  const { dirA, dirC, identityOf, ffOptions, mergeSha, followSha } = await ancestorFfWorld();
  let ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), mergeSha));
  // origin 漂移 → fetch 前即停
  git(["remote", "set-url", "origin", "https://gitlab.internal/org/repo.git"], dirA);
  ff = await pr.fastForwardAncestorRoot(ffOptions(() => identityOf(dirA), followSha));
  assert.equal(ff.status, "blocked");
  assert.match(ff.reason, /不一致/);
});

// —— 块C4-R3：科研候选校验器（原始队列完整值、逐 job proof、plan.id 键控、HEAD 逐 blob 绑定、每次写入前可重算） ——
const verifiedCompletion = require("../../dist/features/VerifiedCompletion.js");
function proofedJob(plan, index, commandId, workerId, outputDir) {
  const job = { index, case: "case-" + index, seed: index, commandId, workerId, outputDir, status: "completed" };
  job.verifiedCompletion = { schemaVersion: 1, identity: verifiedCompletion.completionIdentity(plan, job), verifiedAt: "2026-10-25T00:00:00.000Z", exitCode: 0 };
  return job;
}
function unproofedJob(index, outputDir) {
  return { index, case: "case-" + index, seed: index, commandId: "cmd-u" + index, workerId: "w1", outputDir, status: "completed" };
}
function headSha(repo) { return git(["rev-parse", "HEAD"], repo).trim(); }
async function candidateOf(repo, plans, selected, extra = {}) {
  const identity = probe.readGitIdentity(repo); // dist 实际导出名是 readGitIdentity（legacy.ts 以别名导入）；原名会 TypeError
  return binding.buildResearchCandidate({
    runner: binding.runGitBinary, root: repo, commonDir: identity.commonDir || path.join(repo, ".git"),
    branch: identity.branch, headCommit: identity.headCommit, dirty: identity.dirty,
    queueState: "ok", plans, selectedPlanIds: selected, ...extra,
  });
}

function researchCandidateWorld() {
  const repo = makeRepo("r3ab");
  fs.mkdirSync(path.join(repo, "experiments"), { recursive: true });
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "experiments", "a.yaml"), "run: v1\n", "utf8");
  fs.writeFileSync(path.join(repo, "pkg", "model.py"), "w = 1\n", "utf8");
  git(["add", "-A"], repo);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "-m", "v1 tree"], repo);
  const manifest = manifestFor(repo, ["experiments/a.yaml", "pkg/model.py", "tracked.txt"]);
  const rev = manifest.manifest["experiments/a.yaml"].sha256;
  const planA = { id: "plan-A", projectId: "proj", planFile: "experiments/a.yaml", revision: rev, codeFingerprint: "fingerprint-A", executionMode: "train", executionSource: manifest, jobs: [proofedJob({ id: "plan-A", projectId: "proj" }, 0, "cmdA0", "w1", "out/a0"), unproofedJob(1, "out/a1")] };
  const planB = { id: "plan-B", projectId: "proj", planFile: "experiments/a.yaml", revision: rev, codeFingerprint: "fingerprint-B", executionMode: "train", executionSource: manifest, jobs: [unproofedJob(0, "out/b0"), proofedJob({ id: "plan-B", projectId: "proj" }, 1, "cmdB1", "w1", "out/b1")] };
  // proof 必须按各自 plan 计算 identity（上面 proofedJob 用了最小 plan 字段——补全为完整 plan 后重算）
  planA.jobs[0].verifiedCompletion.identity = verifiedCompletion.completionIdentity(planA, planA.jobs[0]);
  planB.jobs[1].verifiedCompletion.identity = verifiedCompletion.completionIdentity(planB, planB.jobs[1]);
  return { repo, rev, planA, planB };
}

test("C4-R3 候选：同 planFile 两轮各半确证不拼凑，空选择与缺损队列全部拒绝", async () => {
  const { repo, rev, planA, planB } = researchCandidateWorld();
  // A/B 各只有部分确证：任何选择都不许通过；B 不得借 A 的 job0 确证过关
  let cand = await candidateOf(repo, [planA, planB], ["plan-B"]);
  assert.equal(cand.ok, false, "B 的 job0 无确证绝不能借同 planFile 的 A 拼凑成“全验”");
  assert.match(cand.reason, /PLAN experiments\/a\.yaml 第 0 个 job 没有完成确证/);
  cand = await candidateOf(repo, [planA, planB], ["plan-A"]);
  assert.equal(cand.ok, false);
  assert.match(cand.reason, /第 1 个 job 没有完成确证/);
  cand = await candidateOf(repo, [planA, planB], ["plan-A", "plan-B"]);
  assert.equal(cand.ok, false, "两轮合并选择仍逐 plan 逐 job 核，缺口不掩盖");
  // 空选择/队列缺失/损坏：全部拒绝，不自动判优
  assert.equal((await candidateOf(repo, [planA, planB], [])).ok, false, "空选择必须拒绝");
  assert.equal((await candidateOf(repo, undefined, ["plan-A"], { queueState: "missing" })).ok, false);
  assert.equal((await candidateOf(repo, undefined, ["plan-A"], { queueState: "corrupt", queueError: "boom" })).ok, false);
  assert.equal((await candidateOf(repo, [], ["plan-Gone"])).ok, false, "队列里找不到的 id＝撤证/变化");
});

test("C4-R3 候选：完整轮次按 plan.id 隔离，HEAD 变更逐 blob 核对", async () => {
  const { repo, rev, planA, planB } = researchCandidateWorld();
  // 补全确证后：按原 id 只核本轮；A/B 各自成候选且摘要互不相同
  planA.jobs[1] = proofedJob(planA, 1, "cmdA1", "w1", "out/a1");
  planB.jobs[0] = proofedJob(planB, 0, "cmdB0", "w1", "out/b0");
  const candB = await candidateOf(repo, [planA, planB], ["plan-B"]);
  assert.equal(candB.ok, true, JSON.stringify(candB.reason));
  assert.equal(candB.plans.length, 1);
  assert.equal(candB.plans[0].planId, "plan-B");
  assert.equal(candB.headCommit, headSha(repo).toLowerCase(), "候选绑定完整 40 位 HEAD");
  const candA = await candidateOf(repo, [planA, planB], ["plan-A"]);
  assert.notEqual(candA.digest, candB.digest, "同 blob 不同轮次（id/指纹）摘要必须不同——选择按 plan.id 键控");
  const candBoth = await candidateOf(repo, [planA, planB], ["plan-A", "plan-B"]);
  assert.equal(candBoth.plans.length, 2);
  // 版本对应所选：a.yaml 提交 v2 后，旧轮 A 的清单不再等于 HEAD（绝不借旧确证冒充新版本）
  commitFile(repo, "experiments/a.yaml", "run: v2\n", "v2 tree");
  const candAfterV2 = await candidateOf(repo, [planA, planB], ["plan-A"]);
  assert.equal(candAfterV2.ok, false, "HEAD 已前进到 v2：v1 轮清单 blob 不再匹配");
  assert.match(candAfterV2.reason, /无法逐 blob 等于冻结清单/);
  // 撤证/命令变化/版本字段变化/清单缺失：确认后任何破坏 → ok:false（调用方据此零写入）
  commitFile(repo, "experiments/a.yaml", "run: v1\n", "back to v1 bytes");
  assert.equal((await candidateOf(repo, [planA, planB], ["plan-A"])).ok, true, "同字节再提交后 blob 绑定依旧成立");
});

test("C4-R3 候选：撤证、命令、版本、清单与终止文字不能代替完成确证", async () => {
  const { repo, rev, planA, planB } = researchCandidateWorld();
  planA.jobs[1] = proofedJob(planA, 1, "cmdA1", "w1", "out/a1");
  planB.jobs[0] = proofedJob(planB, 0, "cmdB0", "w1", "out/b0");
  const savedProof = planA.jobs[0].verifiedCompletion;
  delete planA.jobs[0].verifiedCompletion;
  assert.equal((await candidateOf(repo, [planA, planB], ["plan-A"])).ok, false, "撤证必须立即可见");
  planA.jobs[0].verifiedCompletion = savedProof;
  planA.jobs[0].commandId = "cmdA0-changed";
  assert.equal((await candidateOf(repo, [planA, planB], ["plan-A"])).ok, false, "命令变化使 proof 身份不再全等");
  planA.jobs[0].commandId = "cmdA0";
  planA.revision = "f".repeat(64);
  assert.equal((await candidateOf(repo, [planA, planB], ["plan-A"])).ok, false, "版本字段变化＝不同候选");
  planA.revision = rev;
  const savedSource = planA.executionSource;
  delete planA.executionSource;
  assert.equal((await candidateOf(repo, [planA, planB], ["plan-A"])).ok, false, "manifest 缺失＝候选不成立");
  planA.executionSource = savedSource;
  // TrustedTerminalProof/状态文字不是科研完成确证
  const terminalOnly = { ...planB, id: "plan-T", jobs: [unproofedJob(0, "out/t0")] };
  terminalOnly.jobs[0].trustedTerminalProof = { schemaVersion: 1, identity: verifiedCompletion.completionIdentity(terminalOnly, terminalOnly.jobs[0]), provenAt: "2026-10-25T00:00:00.000Z", outcome: "completed" };
  terminalOnly.jobs[0].status = "completed";
  terminalOnly.jobs.forEach(job => { job.verifiedCompletion = undefined; });
  assert.equal((await candidateOf(repo, [terminalOnly], ["plan-T"])).ok, false, "TrustedTerminalProof 只证终止，不是科研完成");
});

test("C4-R3 候选：dirty 如实进入摘要，恢复同字节后摘要稳定", async () => {
  const { repo, rev, planA, planB } = researchCandidateWorld();
  planA.jobs[1] = proofedJob(planA, 1, "cmdA1", "w1", "out/a1");
  planB.jobs[0] = proofedJob(planB, 0, "cmdB0", "w1", "out/b0");
  // dirty 如实透出（新的写入由调用方要求 dirty===false；同 HEAD 下重算必须稳定）
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n/clean_dir/\n", "utf8");
  const bClean = await candidateOf(repo, [planB], ["plan-B"]);
  assert.equal(bClean.ok, true, JSON.stringify(bClean.reason));
  fs.writeFileSync(path.join(repo, "scratch.txt"), "dirty\n", "utf8");
  const dirtyCand = await candidateOf(repo, [planB], ["plan-B"]);
  assert.equal(dirtyCand.ok, true, "dirty 只如实透出，由写入门禁拒绝新的远端写入");
  assert.equal(dirtyCand.dirty, true);
  assert.notEqual(dirtyCand.digest, bClean.digest, "dirty 变化进入摘要：确认后再脏即复核失败");
  // 通过夹具专属 exclude 恢复同一 clean Git 输入；文件原字节保留，不做完整文件清理。
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n/scratch.txt\n", "utf8");
  assert.equal(fs.readFileSync(path.join(repo, "scratch.txt"), "utf8"), "dirty\n", "临时文件保留，不执行永久删除");
  const cleanAgain = await candidateOf(repo, [planB], ["plan-B"]);
  assert.equal(cleanAgain.digest, bClean.digest, "同输入重算摘要稳定（无易变时间戳）");
});

test("C4-R3 revalidate 钩子：push 前失败零写入；push 后失败不创建 PR；merge 写指令前失败零发送", async () => {
  const gateFail = { ok: false, reason: "候选摘要已变化（测试）" };
  // push 前失败 → 零 git 写入、零 gh 调用（产品先核本地头再科研回调是正确次序：fixture 必须应答 rev-parse 查询）
  const localHeadRow = { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" };
  const gitA = recordingGit([localHeadRow, ...baseScript()]);
  const ghA = recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]);
  const previewA = await previewOf(baseScript());
  let result = await pr.createBranchPullRequest({ git: gitA.runner, gh: ghA.runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: previewA.digest, revalidate: async () => gateFail });
  assert.equal(result.status, "blocked-verification", JSON.stringify(result));
  assert.equal(gitA.calls.filter(call => call.args.startsWith("push")).length, 0);
  assert.equal(ghA.calls.filter(call => call.args.startsWith("pr create")).length, 0);
  // push 成功落地后、创建 PR 前失败 → push 收据 ok、绝不 pr create
  const ledgerB = memoryLedger();
  const gitB2 = recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^ls-remote --heads origin exp\//, stdout: "", uses: 1 },
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    ...baseScript(),
  ]);
  const ghB2 = recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }, { match: /^pr create/, stdout: "MUST NOT CREATE" }]);
  let calls = 0;
  result = await pr.createBranchPullRequest({ git: gitB2.runner, gh: ghB2.runner, ledger: ledgerB, ...PR_OPTS, title: "t", body: "b", previewDigest: previewA.digest, revalidate: async () => (++calls === 1 ? { ok: true } : gateFail) });
  assert.equal(result.status, "blocked-verification", JSON.stringify(result));
  assert.equal(ghB2.calls.filter(call => call.args.startsWith("pr create")).length, 0, "复核失败后不得创建 PR");
  assert.ok(ledgerB.rows().some(row => row.action === "push" && row.outcome === "ok"), "已确证落地的 push 保留 ok 收据");
  assert.ok(!ledgerB.rows().some(row => row.action === "pr-create"), "未发生的创建不留收据");
  // merge：写指令前失败 → 零 pr merge 调用、unknown 视图不发送
  const ghM = recordingGit([{ match: /^pr view 21/, stdout: jsonBuf(PR_VIEW()) }, { match: /^pr merge/, stdout: "MUST NOT MERGE" }]);
  const mergeResult = await pr.mergeBranchPullRequest({ gh: ghM.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", revalidate: async () => gateFail });
  assert.equal(mergeResult.status, "blocked-verification");
  assert.equal(ghM.calls.filter(call => call.args.startsWith("pr merge")).length, 0);
  // revalidate 抛异常＝拒绝（异常不得当成通过；同样先应答产品对本地头的确认查询）
  result = await pr.createBranchPullRequest({ git: recordingGit([localHeadRow, ...baseScript()]).runner, gh: recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]).runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: previewA.digest, revalidate: async () => { throw new Error("boom"); } });
  assert.equal(result.status, "blocked-verification");
});

test("C5 R5a/b/c：跨 cwd/大小写语义身份拒绝与精确结算；专用租约包裹；merge 前最终复核与 raw URL 脱敏", async () => {
  // —— R5a：语义身份＝仓库(规范化)+动作+分支+SHA+base，与 cwd 拼写/大小写/时间戳新旧无关 ——
  assert.equal(pr.receiptKey(["/repo", "exp/m1", FULL_SHA, "main"], "push", SELECTOR),
    pr.receiptKey(["D:\\Elsewhere\\", "exp/m1", FULL_SHA.toUpperCase(), "main"], "push", "github.com/ORG/REPO"));
  const gitA = recordingGit(baseScript());
  const ghA = recordingGit([{ match: /^pr list/, stdout: jsonBuf([]) }]);
  const ledgerA = memoryLedger([{ key: pr.receiptKey(["D:/elsewhere", "exp/m1", FULL_SHA, "main"], "push", "github.com/Org/Repo"),
    root: "D:/elsewhere", branch: "exp/m1", sourceSha: FULL_SHA.toLowerCase(), base: "main", repoSelector: "github.com/Org/Repo",
    action: "push", attemptAt: "2026-10-24T23:00:00Z", outcome: "unknown" }]);
  const previewA = await previewOf(baseScript());
  let result = await pr.createBranchPullRequest({ git: gitA.runner, gh: ghA.runner, ledger: ledgerA, ...PR_OPTS, title: "t", body: "b", previewDigest: previewA.digest });
  assert.equal(result.status, "blocked-unknown", "另一窗口以别的工作目录拼写留下的同身份 push unknown（更旧时间戳）也必须先只读对账");
  assert.equal(gitA.calls.filter(call => call.args.startsWith("push")).length, 0);
  // —— R5a：MERGED 恢复精确结算两条同键尝试， unrelated unknown 原样保留 ——
  const mKey = pr.mergeReceiptKey(SELECTOR, 21, FULL_SHA);
  const ledgerB = memoryLedger([
    { key: mKey, root: "/repo", branch: "pr#21", sourceSha: FULL_SHA, base: "main", repoSelector: SELECTOR, action: "merge", attemptAt: "2026-10-25T00:00:00Z", outcome: "unknown", attemptId: "m1" },
    { key: mKey, root: "/repo", branch: "pr#21", sourceSha: FULL_SHA, base: "main", repoSelector: SELECTOR, action: "merge", attemptAt: "2026-10-25T00:00:01Z", outcome: "unknown", attemptId: "m2" },
    { key: pr.receiptKey(["/repo", "exp/m1", FULL_SHA, "main"], "push", SELECTOR), root: "/repo", branch: "exp/m1", sourceSha: FULL_SHA, base: "main", repoSelector: SELECTOR, action: "push", attemptAt: "2026-10-25T00:00:02Z", outcome: "unknown", attemptId: "p1" },
  ]);
  const ghB = recordingGit([
    { match: /^pr merge/, stdout: "MUST NOT MERGE" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA } })) },
  ]);
  const mergedRes = await pr.mergeBranchPullRequest({ gh: ghB.runner, ledger: ledgerB, cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1" });
  assert.equal(mergedRes.status, "merged", JSON.stringify(mergedRes));
  const rowsB = ledgerB.rows();
  assert.equal(rowsB.filter(row => row.key === mKey && row.outcome === "unknown").length, 0);
  assert.equal(rowsB.filter(row => row.key === mKey && row.outcome === "ok").length, 2, "两条尝试各自精确结清，不塌成一条");
  assert.ok(rowsB.some(row => row.attemptId === "p1" && row.outcome === "unknown"), "其它操作的 unknown 收据绝不顺带清掉");
  // —— R5b：create/merge 全程包在 C4 专用租约内（id 正确、fn 在租约内执行） ——
  const leasesC = [];
  const gitC = recordingGit([
    { match: /^push/, stdout: "" },
    { match: /^ls-remote --heads origin exp\//, stdout: "", uses: 1 },
    { match: /^ls-remote --heads origin exp\//, stdout: FULL_SHA + "\trefs/heads/exp/m1\n" },
    { match: /^rev-parse --verify refs\/heads\/exp\/m1/, stdout: FULL_SHA + "\n" },
    ...baseScript(),
  ]);
  const ghC = recordingGit([
    { match: /^pr list/, stdout: jsonBuf([]) },
    { match: /^pr create/, stdout: "https://github.com/org/repo/pull/31\n" },
    { match: /^pr view 31/, stdout: jsonBuf(PR_VIEW({ number: 31 })) },
  ]);
  result = await pr.createBranchPullRequest({ git: gitC.runner, gh: ghC.runner, ledger: memoryLedger(), ...PR_OPTS, title: "t", body: "b", previewDigest: previewA.digest,
    withRepoLease: async (leaseId, fn) => { leasesC.push(leaseId); return fn(); } });
  assert.equal(result.status, "created", JSON.stringify(result));
  assert.equal(leasesC.length, 1);
  // R5 统一身份（返修3）：键＝规范化已确认仓＋实际 head 引用，绝不含 cwd/base；与 merge 同一条规则。
  assert.equal(leasesC[0], "branch-pr-op:github.com/org/repo:exp/m1", leasesC[0]);
  const leasesM = [];
  const ghM = recordingGit([
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW()), uses: 1 },
    { match: /^pr merge/, stdout: "merged" },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA } })) },
  ]);
  const mergeLeased = await pr.mergeBranchPullRequest({ gh: ghM.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1",
    withRepoLease: async (leaseId, fn) => { leasesM.push(leaseId); return fn(); } });
  assert.equal(mergeLeased.status, "merged");
  assert.equal(leasesM[0], "branch-pr-op:github.com/org/repo:exp/m1", leasesM[0]);
  assert.equal(leasesM[0], leasesC[0], "create 与 merge 共用同一仓/引用身份规则：同 repo+head ref 落同一把锁");
  // —— R5c：真实仓 fetch 之后 origin 才漂移 → merge 前停止，且错误绝不回显 raw URL ——
  const originDir = tempDir("se-r5-origin-");
  git(["init", "-q", "--bare", "-b", "main", originDir], originDir);
  const seed = tempDir("se-r5-seed-");
  const dirA = tempDir("se-r5-A-"); const dirD = tempDir("se-r5-D-");
  git(["clone", "-q", originDir, dirA], seed);
  commitFile(dirA, "tracked.txt", "seed\n", "seed");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirA);
  git(["clone", "-q", originDir, dirD], seed);
  commitFile(dirD, "tracked.txt", "merged-remote\n", "remote advance");
  git(["push", "-q", "origin", "refs/heads/main:refs/heads/main"], dirD);
  const mergeSha = git(["rev-parse", "HEAD"], dirD).trim();
  const expectedUrl = git(["remote", "get-url", "origin"], dirA).trim();
  const identityOfDir = (dir) => probe.readGitIdentity(dir); // 同 C5 ff：观测面必须与产品注入的探针一致（NoSystem env 会失真 autocrlf）
  const seen = [];
  const hijackFetch = async (args, cwd, stdin) => {
    const out = await pr.runGitPullRequest(args, cwd, stdin);
    seen.push(args.join(" "));
    if (args[0] === "fetch" && out.code === 0)
      git(["remote", "set-url", "origin", "https://tok-secret@github.com/org/other.git"], dirA);
    return out;
  };
  let ff = await pr.fastForwardAncestorRoot({ git: hijackFetch, cwd: dirA, remoteName: "origin", base: "main", expectedMergeCommit: mergeSha, expectedRemoteUrl: expectedUrl, readIdentity: () => identityOfDir(dirA) });
  assert.equal(ff.status, "blocked", JSON.stringify(ff));
  assert.match(ff.reason, /不一致/);
  assert.ok(!ff.reason.includes("tok-secret") && !ff.reason.includes("tok-secret@github.com"), "错误信息绝不携带含凭据的 raw URL: " + ff.reason);
  assert.ok(!seen.some(line => line.startsWith("merge ")), "漂移后绝不执行 merge");
  git(["remote", "set-url", "origin", expectedUrl], dirA);
  // —— R5c：祖先检查通过之后、merge 之前本机 HEAD 又移动 → 按初始确认停止 ——
  const beforeHead = git(["rev-parse", "HEAD"], dirA).trim().toLowerCase();
  const seen2 = [];
  const hijackLateCommit = async (args, cwd, stdin) => {
    const out = await pr.runGitPullRequest(args, cwd, stdin);
    seen2.push(args.join(" "));
    if (args[0] === "merge-base" && args[1] === "--is-ancestor" && String(args[2]).toLowerCase() === beforeHead && out.code === 0)
      commitFile(dirA, "late.txt", "late\n", "late local move");
    return out;
  };
  ff = await pr.fastForwardAncestorRoot({ git: hijackLateCommit, cwd: dirA, remoteName: "origin", base: "main", expectedMergeCommit: mergeSha, expectedRemoteUrl: expectedUrl, readIdentity: () => identityOfDir(dirA) });
  assert.equal(ff.status, "blocked", JSON.stringify(ff));
  assert.match(ff.reason, /merge 前本机 HEAD/);
  assert.ok(!seen2.some(line => line.startsWith("merge ")), "HEAD 漂移后绝不执行 merge");
  assert.equal(git(["rev-list", "--merges", "HEAD"], dirA).trim(), "", "本机未被写入任何合并提交");
});

/* ————————————— 块C4-R6（主控 2026-10-25 精读后的四处必须返修）———————————————
 * 本轮接线故障（alreadyMerged 恢复把空 mergeSHA 交给祖先确认）正是“helper 全绿也发现不了”一类：
 * 回归必须跑真实 legacy 入口。按 unifiedDispatchAdmission 的既有 AST 法身口径，从当前完整 legacy.ts
 * 提取实际方法体进隔离 vm，外部 git/gh 一律注入 stub（不联网）；真实仓/真实租约/真实模块另各占用例。 */
const DPQ = require("../../dist/features/DistributedPlanQueue.js");

function makeLegacyUiHost(env) {
  const ts = require("typescript");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "extension", "legacy.ts"), "utf8");
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  let cls = null;
  const visit = n => { if (ts.isClassDeclaration(n) && n.name && n.name.text === "RealtimeTunnelPanelProvider") cls = n; ts.forEachChild(n, visit); };
  visit(ast);
  if (!cls) throw new Error("legacy.ts 中未找到 RealtimeTunnelPanelProvider 类");
  const names = ["branchQueueSnapshotFor", "branchPrContext", "branchPrReceiptLedger", "branchPrRepoLease",
    "buildBranchResearchCandidate", "branchResearchCandidateFlow", "branchResearchRevalidate", "mergeBranchPrFromUi", "confirmAndFastForwardAncestor"];
  const members = cls.members.filter(n => n.name && names.includes(n.name.getText(ast)));
  if (members.length !== names.length) throw new Error("C4 UI 法身闭包不齐：" + names.join(","));
  const Host = vm.runInNewContext(ts.transpileModule("class Host{" + members.map(m => m.getText(ast)).join("\n") + "};Host",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    vscode: {
      window: {
        showQuickPick: async (items, options) => { env.events.push({ kind: "pick", title: String(options && options.title || ""), items: items.map(row => row.label + "§" + (row.description || "") + "§" + (row.detail || "")) }); return env.pickItems ? env.pickItems(items) : items.slice(); },
        showInformationMessage: async (title, options) => { env.events.push({ kind: "info", title: String(title), detail: String((options && options.detail) || "") }); return "知道了"; },
        showWarningMessage: async (title, options, ...actions) => { env.events.push({ kind: "warn", title: String(title), detail: String((options && options.detail) || "") }); return env.answer ? env.answer(String(title), actions) : actions[0]; },
      },
    },
    UiCommandCancelled: class UiCommandCancelled extends Error {},
    readGitIdentityProbe: probe.readGitIdentity,
    BranchPullRequest: env.branchPullRequest,
    BranchHeadBinding: binding,
    DistributedPlanQueue: DPQ,
    canonicalComparablePath: store.canonicalComparablePath,
    hasVerifiedCompletion: verifiedCompletion.hasVerifiedCompletion,
    atomicWriteText: require("../../dist/state/StateStore.js").atomicWriteText,
    errorMessage: e => String((e && e.message) || e),
    path, fs: fs.promises, crypto, API_DISCOVERY_DIR: env.apiDir,
  });
  const h = new Host();
  Object.assign(h, {
    context: { globalStorageUri: { fsPath: env.storage } },
    postState() {}, scheduleBranchProjectsVerify(reason) { env.events.push({ kind: "verify", reason: String(reason) }); },
    pickBranchProject: async () => { throw new Error("测试必须显式给 branchProjectId，不应触发人工选择"); },
    withPluginStateFileLease: async (root, file, actionType, label, work) => work(),
    branchProjectsProjection: () => env.projection,
  });
  return h;
}
function uiEnv(overrides) {
  const dir = tempDir("se-r6-ui-");
  const apiDir = path.join(dir, "api"); const storage = path.join(dir, "storage");
  fs.mkdirSync(apiDir, { recursive: true }); fs.mkdirSync(storage, { recursive: true });
  return { events: [], apiDir, storage, answer: undefined, pickItems: undefined, projection: { branches: [], ancestors: [] }, ...overrides };
}
function seedProofedQueue(storage, root, planId, planFile, revision, manifest, jobCount) {
  const q = DPQ.enqueuePlan(DPQ.emptyDistributedQueue(), { projectId: "proj-ui", executionMode: "train", planFile, revision,
    codeFingerprint: "fp-" + planId, resultPathPolicy: "declared", executionSource: manifest,
    jobs: Array.from({ length: jobCount }, (_unused, index) => ({ index, case: "c" + index, seed: index + 1, outputDir: "out/" + index })) }, planId);
  const plan = q.plans.find(row => row.id === planId);
  plan.jobs.forEach((job, index) => {
    job.commandId = "cmd-" + planId + "-" + index; job.workerId = "w1"; job.status = "completed";
    job.verifiedCompletion = { schemaVersion: 1, identity: verifiedCompletion.completionIdentity(plan, job), verifiedAt: "2026-10-25T00:00:00.000Z", exitCode: 0 };
  });
  const file = DPQ.distributedQueuePath(storage, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DPQ.serializeDistributedQueue(q), "utf8");
  // 正常项目运行状态忽略边界（宿主 2026-10-25 现场证实：该测试仓 dirty 的唯一来源就是这个项目内运行时队列文件）：
  // 只给本测试临时仓的 .git/info/exclude 添加由实际写入路径 path.relative(root, file) 派生的精确文件规则——
  // 不写死 digest、不忽略源码/整目录树、不触碰仓库全局或用户 exclude、不改 HEAD/产品 dirty 判定。
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (relative && !relative.startsWith("../") && !path.isAbsolute(relative)) {
    const excludeFile = path.join(root, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prior = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (!prior.split(/\r?\n/).some(row => row.trim() === "/" + relative))
      fs.appendFileSync(excludeFile, (prior === "" || prior.endsWith("\n") ? "" : "\n") + "/" + relative + "\n", "utf8");
  }
  // 用产品同款真实探针断言真实 status 干净（与产品 dirty 判定同一观测面），不伪造 dirty=false。
  const identity = probe.readGitIdentity(root);
  assert.equal(identity.error, "");
  assert.equal(identity.dirty, false, "运行时队列写入并按准确路径排除后，真实 Git status 必须干净：" + JSON.stringify({ file, relative, status: identity.dirty }));
  return file;
}
function uiBranchFixture(name) {
  const root = fs.realpathSync(makeRepo(name));
  fs.mkdirSync(path.join(root, "experiments"), { recursive: true });
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "experiments", "a.yaml"), "run: v1\n", "utf8");
  fs.writeFileSync(path.join(root, "pkg", "model.py"), "w = 1\n", "utf8");
  git(["add", "-A"], root);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=Branch Test", "commit", "-q", "-m", "plan tree"], root);
  git(["checkout", "-q", "-B", "exp/m1"], root);
  const ancRoot = fs.realpathSync(makeRepo(name + "-anc"));
  git(["remote", "add", "origin", "https://github.com/org/repo.git"], ancRoot);
  return { root, ancRoot, head: git(["rev-parse", "HEAD"], root).trim().toLowerCase() };
}
function uiProjection(root, ancRoot) {
  return { branches: [{ record: { id: "b1", workspaceRoot: root, branch: "exp/m1", ancestorId: "a1", label: "" } }],
    ancestors: [{ record: { id: "a1", gitRoot: ancRoot, remoteName: "origin", targetBranch: "main", remoteUrl: "https://github.com/org/repo.git" } }] };
}

test("C4-R6 统一租约身份：已确认仓＋head ref 定锁；cwd/大小写拼写/不同 base 不绕锁；未知 target 先拒不借用", async () => {
  const captured = [];
  const withRepoLease = async (leaseId) => { captured.push(leaseId); return { status: "reused", prNumber: 0 }; }; // 只验键形成，不进入临界段
  const mk = (over = {}) => pr.createBranchPullRequest({ git: recordingGit([]).runner, gh: recordingGit([]).runner, ledger: memoryLedger(),
    title: "t", body: "b", previewDigest: "x", withRepoLease, ...PR_OPTS, ...over });
  await mk();
  await mk({ cwd: "C:\\Other\\Clone\\Path" });
  await mk({ registeredRemoteUrl: "git@github.com:Org/Repo.git" });
  await mk({ registeredRemoteUrl: "https://github.com/Org/Repo" });
  await mk({ base: "master" });
  assert.equal(captured.length, 5);
  assert.ok(captured.every(key => key === "branch-pr-op:github.com/org/repo:exp/m1"), JSON.stringify(captured));
  const before = captured.length;
  const denied = await mk({ registeredRemoteUrl: "https://gitlab.com/org/repo.git" });
  assert.equal(denied.status, "blocked-unknown", JSON.stringify(denied));
  assert.match(denied.reason, /无法规范化/);
  const deniedCred = await mk({ registeredRemoteUrl: "https://tok-secret@github.com/org/repo.git" });
  assert.equal(deniedCred.status, "blocked-unknown", JSON.stringify(deniedCred));
  assert.ok(!JSON.stringify(deniedCred).includes("tok-secret"), "未知 target 拒绝原因也不回显凭据");
  assert.equal(captured.length, before, "未知 target 既不加锁也绝不无锁放行");
  await mk({ registeredRemoteUrl: "https://github.com/org/other.git" });
  await mk({ branch: "Exp/M1" });
  assert.equal(new Set(captured.slice(before)).size, 2, "不同仓/不同 head 引用（refs 大小写敏感）不误并同一把锁");
  await pr.mergeBranchPullRequest({ gh: recordingGit([]).runner, ledger: memoryLedger(), cwd: "/any", repoSelector: "github.com/Org/Repo",
    prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", withRepoLease });
  assert.equal(captured[captured.length - 1], "branch-pr-op:github.com/org/repo:exp/m1", "merge 与 create 共用同一身份规则");
  await pr.mergeBranchPullRequest({ gh: recordingGit([]).runner, ledger: memoryLedger(), cwd: "/any", repoSelector: "github.com/org/repo",
    prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m2", withRepoLease });
  assert.equal(captured[captured.length - 1], "branch-pr-op:github.com/org/repo:exp/m2");
});

test("C4-R6 真实互斥：两个独立 cwd 同仓/同引用并发创建只有一个不可逆临界段；第二窗被预览不一致拦停后重预览按身份复用", async () => {
  const remote = { heads: { main: BASE_SHA }, prs: [], pushCount: 0, createCount: 0 };
  const makeFakeGit = (options = {}) => {
    const calls = [];
    const runner = async (args) => {
      const line = args.join(" "); calls.push(line);
      if (line === "remote get-url origin" || line.startsWith("remote get-url --push --all origin")) return { code: 0, stdout: buf("https://github.com/org/repo.git\n"), stderr: "" };
      if (line === "ls-remote --heads origin main") return { code: 0, stdout: buf(BASE_SHA + "\trefs/heads/main\n"), stderr: "" };
      if (line === "ls-remote --heads origin exp/m1") { const sha = remote.heads["exp/m1"]; return { code: 0, stdout: buf(sha ? sha + "\trefs/heads/exp/m1\n" : ""), stderr: "" }; }
      if (line.startsWith("rev-list")) return { code: 128, stdout: buf(""), stderr: "unknown revision" };
      if (line === "rev-parse --verify refs/heads/exp/m1^{commit}") return { code: 0, stdout: buf(FULL_SHA + "\n"), stderr: "" };
      if (line.startsWith("push origin")) {
        if (options.onPushEnter) options.onPushEnter();
        if (options.pushGate) await options.pushGate; // 确定性持锁边界：W1 真的停在临界段内的 push，直到受控放行（不再用 40ms 猜）
        remote.heads["exp/m1"] = FULL_SHA; remote.pushCount++; return { code: 0, stdout: buf(""), stderr: "" };
      }
      throw new Error("unexpected fake git: " + line);
    };
    return { runner, calls };
  };
  const makeFakeGh = () => {
    const calls = [];
    const runner = async (args) => {
      const line = args.join(" "); calls.push(line);
      if (line.startsWith("pr list")) return { code: 0, stdout: jsonBuf(remote.prs), stderr: "" };
      if (line.startsWith("pr create")) { remote.createCount++; remote.prs.push(PR_OPEN({ number: 31, url: "https://github.com/org/repo/pull/31" })); return { code: 0, stdout: buf("https://github.com/org/repo/pull/31\n"), stderr: "" }; }
      if (line.startsWith("pr view 31")) return { code: 0, stdout: jsonBuf(PR_VIEW({ number: 31 })), stderr: "" };
      throw new Error("unexpected fake gh: " + line);
    };
    return { runner, calls };
  };
  const srcRepo = makeRepo("r6-src");
  const w1 = fs.realpathSync(tempDir("se-r6-w1-")); git(["clone", "-q", srcRepo, w1], os.tmpdir());
  const w2 = fs.realpathSync(tempDir("se-r6-w2-")); git(["clone", "-q", srcRepo, w2], os.tmpdir());
  const previewT0 = await pr.previewBranchPullRequest({ git: makeFakeGit().runner, gh: makeFakeGh().runner, ...PR_OPTS, cwd: w1 });
  assert.ok(previewT0.ok, JSON.stringify(previewT0.reason));
  const leaseDir = tempDir("se-r6-lease-"); const leaseFile = path.join(leaseDir, "branch-pr-op.lease.json");
  const { ResourceOperationLeaseManager } = require("../../dist/core/ResourceOperationLease.js");
  // 两个真实 manager、独立 windowId：贴近两个独立窗口竞争同一租约文件；锁/ALS/生产代码不动。
  const managerW1 = new ResourceOperationLeaseManager({ leasePath: leaseFile, windowId: "r6-w1", ttlMs: 30000, heartbeatMs: 1000 });
  const managerW2 = new ResourceOperationLeaseManager({ leasePath: leaseFile, windowId: "r6-w2", ttlMs: 30000, heartbeatMs: 1000 });
  const events = [];
  const withLease = (label, manager) => async (leaseId, fn) => {
    events.push(label + ":key:" + leaseId); // 键计算/请求发生在锁外
    return manager.run({ pluginId: "simple-local.simple-experiment", workspaceUri: leaseDir, hostProjectPath: leaseDir,
      actionType: "branch-pr-operation", actionLabel: "R6 租约回归", waitForConflict: true,
      resources: [{ server: "local", project: leaseDir, target: leaseFile }] },
    // enter 必须在真正获锁回调内：此前在 run 之前记 enter＝把"请求租约"误记成"已获临界区"。
    async () => { events.push(label + ":enter"); try { return await fn(); } finally { events.push(label + ":exit"); } });
  };
  // 不用 sleep 猜 W1 是否持锁：以 W1 真实进入 push（临界段内）为边界再启动 W2，随后受控放行。
  let w1PushEntered = null;
  const w1PushEnter = new Promise(resolve => { w1PushEntered = resolve; });
  let releaseW1Push = null;
  const w1PushGate = new Promise(resolve => { releaseW1Push = resolve; });
  const pA = pr.createBranchPullRequest({ git: makeFakeGit({ onPushEnter: () => { events.push("W1:push-enter"); w1PushEntered(); }, pushGate: w1PushGate }).runner, gh: makeFakeGh().runner, ledger: memoryLedger(), ...PR_OPTS, cwd: w1, title: "t", body: "b", previewDigest: previewT0.digest, withRepoLease: withLease("W1", managerW1) });
  const early = await Promise.race([w1PushEnter.then(() => null), pA.then(result => ({ earlyResult: result }))]);
  assert.equal(early, null, "W1 未到达 push 就提前结束（不再放行，直接报告真实结果）events=" + events.join(",") + "：" + JSON.stringify(early));
  const pB = pr.createBranchPullRequest({ git: makeFakeGit().runner, gh: makeFakeGh().runner, ledger: memoryLedger(), ...PR_OPTS, cwd: w2, title: "t", body: "b", previewDigest: previewT0.digest, withRepoLease: withLease("W2", managerW2) });
  assert.ok(events.some(row => row.startsWith("W2:key:")), "W2 的请求已在 W1 持锁期间发出（真实重叠，非事后串行）");
  releaseW1Push(); // 受控放行 W1 的 push 临界段
  const resA = await pA; const resB = await pB;
  assert.equal(resA.status, "created", JSON.stringify(resA));
  assert.equal(resB.status, "blocked-unknown", JSON.stringify(resB));
  assert.match(resB.reason, /预览不一致/, JSON.stringify(resB));
  assert.equal(remote.createCount, 1, "两窗并发同仓/同引用：不可逆临界段只有一个");
  assert.equal(remote.pushCount, 1);
  const keyA = events.find(row => row.startsWith("W1:key:")).slice("W1:key:".length);
  const keyB = events.find(row => row.startsWith("W2:key:")).slice("W2:key:".length);
  assert.equal(keyA, "branch-pr-op:github.com/org/repo:exp/m1");
  assert.equal(keyB, keyA, "不同完整 clone 的同一 repo/ref 必须落同一把锁");
  assert.ok(events.indexOf("W1:enter") < events.indexOf("W1:push-enter"), "enter 记录的是真正获锁后的临界段（push 在其后）");
  assert.ok(events.indexOf("W2:key:" + keyB) < events.indexOf("W1:exit"), "W2 确实在 W1 持有期间请求过（真实重叠，非事后串行）");
  assert.ok(events.indexOf("W1:exit") < events.indexOf("W2:enter"), "W2 的临界段确在 W1 释放后才进入（等待型互斥）");
  const previewB2 = await pr.previewBranchPullRequest({ git: makeFakeGit().runner, gh: makeFakeGh().runner, ...PR_OPTS, cwd: w2 });
  const resB2 = await pr.createBranchPullRequest({ git: makeFakeGit().runner, gh: makeFakeGh().runner, ledger: memoryLedger(), ...PR_OPTS, cwd: w2, title: "t", body: "b", previewDigest: previewB2.digest, withRepoLease: withLease("W2b", managerW2) });
  assert.equal(resB2.status, "reused", JSON.stringify(resB2));
  assert.equal(resB2.prNumber, 31);
  assert.match(resB2.note, /按身份复用/);
  assert.equal(remote.createCount, 1); assert.equal(remote.pushCount, 1, "复用路径零推送零创建");
});

test("C5-R6 readOnly 只读恢复模式：OPEN/读不到/身份不符一律 blocked 且代码路径绝不进 gh pr merge；MERGED 全等则 merged 并按真实事实结清同键 unknown", async () => {
  const ghA = recordingGit([{ match: /^pr view 21/, stdout: jsonBuf(PR_VIEW()) }, { match: /^pr merge/, stdout: "MUST NOT MERGE" }]);
  let res = await pr.mergeBranchPullRequest({ gh: ghA.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", readOnly: true });
  assert.equal(res.status, "blocked-unknown", JSON.stringify(res));
  assert.match(res.reason, /只读恢复/);
  assert.equal(ghA.calls.filter(row => row.args.startsWith("pr merge")).length, 0);
  const ghB = recordingGit([{ match: /^pr view 21/, code: 1, stderr: "gh down" }]);
  res = await pr.mergeBranchPullRequest({ gh: ghB.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", readOnly: true });
  assert.equal(res.status, "blocked-unknown", JSON.stringify(res));
  const key = pr.mergeReceiptKey(SELECTOR, 21, FULL_SHA);
  const ledgerC = memoryLedger([
    { key, root: "/repo", branch: "pr#21", sourceSha: FULL_SHA, base: "main", repoSelector: SELECTOR, action: "merge", attemptAt: "2026-10-25T00:00:00Z", outcome: "unknown", attemptId: "m1" },
    { key: "unrelated-key", root: "/repo", branch: "exp/other", sourceSha: OTHER_SHA, base: "main", repoSelector: SELECTOR, action: "merge", attemptAt: "2026-10-25T00:00:01Z", outcome: "unknown", attemptId: "u1" },
  ]);
  const ghC = recordingGit([{ match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA } })) }, { match: /^pr merge/, stdout: "MUST NOT MERGE" }]);
  res = await pr.mergeBranchPullRequest({ gh: ghC.runner, ledger: ledgerC, cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", readOnly: true });
  assert.equal(res.status, "merged", JSON.stringify(res));
  assert.equal(res.mergeCommit, MERGE_SHA);
  assert.equal(ledgerC.rows().filter(row => row.key === key && row.outcome === "unknown").length, 0, "同键 unknown 按真实 MERGED 事实结清");
  assert.ok(ledgerC.rows().some(row => row.attemptId === "m1" && row.outcome === "ok"));
  assert.ok(ledgerC.rows().some(row => row.key === "unrelated-key" && row.outcome === "unknown"), "无关 unknown 收据不动");
  const ghD = recordingGit([{ match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ state: "MERGED", mergedAt: "x", mergeCommit: { oid: MERGE_SHA }, headRefName: "exp/other" })) }, { match: /^pr merge/, stdout: "MUST NOT MERGE" }]);
  res = await pr.mergeBranchPullRequest({ gh: ghD.runner, ledger: memoryLedger(), cwd: "/repo", repoSelector: SELECTOR, prNumber: 21, verifiedHeadSha: FULL_SHA, base: "main", branch: "exp/m1", readOnly: true });
  assert.equal(res.status, "blocked-unknown", JSON.stringify(res));
  assert.equal(ghD.calls.filter(row => row.args.startsWith("pr merge")).length, 0);
});

test("C4-R6 UI 真实入口 alreadyMerged 恢复：只读 view 取得 mergeCommit 后经独立确认传给 ff；view 变 OPEN 则零 merge 零 ff", async () => {
  const fx = uiBranchFixture("r6-merged");
  const runRecovery = async (viewRow) => {
    const env = uiEnv({ projection: uiProjection(fx.root, fx.ancRoot) });
    const gh = recordingGit([
      { match: /^pr list/, stdout: jsonBuf([PR_OPEN({ state: "MERGED", mergedAt: "2026-10-25T00:00:00Z", headRefOid: fx.head })]), uses: 1 },
      { match: /^pr view 21/, stdout: jsonBuf(viewRow) },
      { match: /^pr merge/, stdout: "MUST NOT MERGE" },
    ]);
    const ffCalls = [];
    const host = makeLegacyUiHost({ ...env, answer: title => title.startsWith("更新本机祖先主线") ? "确认快进" : undefined,
      branchPullRequest: { ...pr, runGh: gh.runner, runGitPullRequest: recordingGit(baseScript()).runner,
        fastForwardAncestorRoot: async (opts) => { ffCalls.push(opts); env.events.push({ kind: "ff" }); return { status: "fast-forwarded", from: BASE_SHA, to: MERGE_SHA }; } } });
    const state = await host.mergeBranchPrFromUi({ branchProjectId: "b1" });
    return { env, gh, ffCalls, state };
  };
  const ok = await runRecovery(PR_VIEW({ state: "MERGED", mergedAt: "2026-10-25T00:00:00Z", mergeCommit: { oid: MERGE_SHA }, headRefOid: fx.head }));
  assert.equal(ok.ffCalls.length, 1, JSON.stringify(ok.env.events.map(row => row.kind)));
  assert.equal(ok.ffCalls[0].expectedMergeCommit, MERGE_SHA, "恢复必须把只读核验到的完整 merge SHA 传给祖先确认");
  assert.equal(ok.ffCalls[0].cwd, fs.realpathSync(fx.ancRoot));
  assert.equal(ok.ffCalls[0].expectedRemoteUrl, "https://github.com/org/repo", "ff 的 expected 只能是本次确认展示过的冻结 target");
  const kinds = ok.env.events.map(row => row.kind);
  assert.ok(kinds.indexOf("info") < kinds.indexOf("warn") && kinds.indexOf("warn") < kinds.indexOf("ff"), "先告知 MERGED 只读重查，再独立确认快进，然后才 ff");
  assert.equal(ok.state.action, "merge-recover"); assert.equal(ok.state.merged, true);
  assert.equal(ok.gh.calls.filter(row => row.args.startsWith("pr merge")).length, 0, "只读恢复绝不发送合并指令");
  const lost = await runRecovery(PR_VIEW({ headRefOid: fx.head })); // view 已变回 OPEN：上次 MERGED 事实不再成立
  assert.equal(lost.ffCalls.length, 0, "view OPEN＝绝不快进");
  assert.equal(lost.state.merged, false);
  assert.ok(lost.env.events.some(row => row.kind === "warn" && row.title.startsWith("只读恢复未通过")), JSON.stringify(lost.env.events));
  assert.ok(!lost.env.events.some(row => row.kind === "warn" && row.title.startsWith("更新本机祖先主线")));
  assert.equal(lost.gh.calls.filter(row => row.args.startsWith("pr merge")).length, 0, "OPEN/未知绝不落入 gh pr merge");
});

function mergeOrderWorld() {
  const fx = uiBranchFixture("r6-order");
  const manifest = manifestFor(fx.root, ["experiments/a.yaml", "pkg/model.py", "tracked.txt"]);
  const rev = manifest.manifest["experiments/a.yaml"].sha256;
  const mergeUiScript = () => recordingGit([
    { match: /^pr list/, stdout: jsonBuf([PR_OPEN({ headRefOid: fx.head })]), uses: 1 },
    { match: /^pr view 21/, stdout: jsonBuf(PR_VIEW({ headRefOid: fx.head })) },
    { match: /^pr merge/, stdout: "MUST NOT MERGE" },
  ]);
  const mergeUiGit = () => recordingGit(baseScript());
  const build = (over) => {
    const env = uiEnv({ projection: uiProjection(fx.root, fx.ancRoot), ...over });
    const queueFile = seedProofedQueue(env.storage, fx.root, "plan-A", "experiments/a.yaml", rev, manifest, 2);
    env.queueFile = queueFile;
    const gh = mergeUiScript();
    env.branchPullRequest = { ...pr, runGh: gh.runner, runGitPullRequest: mergeUiGit().runner };
    return { env, gh, host: makeLegacyUiHost(env), queueFile };
  };
  return { fx, build };
}

test("C4-R6 UI 合并顺序：确认顺序与证据展示，确认后撤证零 merge", async () => {
  const { fx, build } = mergeOrderWorld();
  // 1) 确认后（实际写之前）撤证 → 复核必拦停，零 pr view/pr merge（模块根本未被调用）
  const case1 = build({ answer: (title) => {
    if (title.startsWith("合并 PR #")) {
      const raw = JSON.parse(fs.readFileSync(case1.queueFile, "utf8"));
      delete raw.plans[0].jobs[0].verifiedCompletion;
      fs.writeFileSync(case1.queueFile, JSON.stringify(raw), "utf8");
      return "确认合并";
    } return "确认合并";
  } });
  let thrown = null;
  try { await case1.host.mergeBranchPrFromUi({ branchProjectId: "b1" }); } catch (error) { thrown = error; }
  assert.ok(thrown && /科研确证复核未通过/.test(String(thrown.message)), String(thrown && thrown.message));
  const kinds = case1.env.events.map(row => row.kind);
  assert.ok(kinds.indexOf("pick") >= 0 && kinds.indexOf("pick") < kinds.indexOf("warn"), "先有 PLAN 选择，后有最终确认弹窗");
  const pickEvent = case1.env.events.find(row => row.kind === "pick");
  assert.equal(pickEvent.items.length, 1);
  assert.match(pickEvent.items[0], /2\/2 job 完成确证/);
  assert.match(pickEvent.items[0], /id plan-A/);
  const modal = case1.env.events.find(row => row.kind === "warn" && row.title.startsWith("合并 PR #"));
  assert.ok(modal, JSON.stringify(case1.env.events));
  assert.match(modal.detail, /plan-A/, "确认前必须展示所选 plan.id 与确证证据");
  assert.ok(modal.detail.includes(fx.head), "确认前展示完整 40 位源 SHA：" + modal.detail.slice(0, 200));
  assert.match(modal.detail, /全部完成确证/); assert.match(modal.detail, /清单摘要/); assert.match(modal.detail, /覆盖限制/);
  assert.equal(case1.gh.calls.filter(row => row.args.startsWith("pr view") || row.args.startsWith("pr merge")).length, 0, "复核拦停后模块未被调用：零合并视图查询、零 merge");
});

test("C4-R6 UI 合并顺序：空选择不展示确认且零 merge", async () => {
  const { fx, build } = mergeOrderWorld();
  // 2) 空选择＝拒绝：证据弹窗都不出现
  const case2 = build({ pickItems: () => [] });
  let thrown2 = null;
  try { await case2.host.mergeBranchPrFromUi({ branchProjectId: "b1" }); } catch (error) { thrown2 = error; }
  assert.ok(thrown2 && /未选择任何 PLAN/.test(String(thrown2.message)), String(thrown2 && thrown2.message));
  assert.ok(!case2.env.events.some(row => row.kind === "warn" && row.title.startsWith("合并 PR #")));
  assert.equal(case2.gh.calls.filter(row => row.args.startsWith("pr merge")).length, 0);
});

test("C4-R6 UI 合并顺序：看到证据后取消确认零 merge", async () => {
  const { fx, build } = mergeOrderWorld();
  // 3) 看到证据后取消确认＝零写入
  const case3 = build({ answer: (title) => title.startsWith("合并 PR #") ? "" : "确认合并" });
  let thrown3 = null;
  try { await case3.host.mergeBranchPrFromUi({ branchProjectId: "b1" }); } catch (error) { thrown3 = error; }
  assert.ok(thrown3 && /已取消合并/.test(String(thrown3.message)), String(thrown3 && thrown3.message));
  assert.ok(case3.env.events.some(row => row.kind === "warn" && row.title.startsWith("合并 PR #") && /plan-A/.test(row.detail)));
  assert.equal(case3.gh.calls.filter(row => row.args.startsWith("pr merge")).length, 0);
});

test("C4-R6 UI 合并顺序：dirty 拒绝说明状态目录边界且零查询", async () => {
  const { fx, build } = mergeOrderWorld();
  // 4) dirty 门拒绝文案带本机运行状态准备提示（锚点：branchResearchCandidateFlow 的 dirty 门；仅该门，不泛加）
  const case4 = build({ answer: () => "确认合并" });
  fs.writeFileSync(path.join(fx.root, "scratch-untracked.txt"), "dirty\n", "utf8"); // 模拟未跟踪内容使 dirty=true（队列夹具已在 build 时按真实路径排除并核过 clean）
  let thrown4 = null;
  try { await case4.host.mergeBranchPrFromUi({ branchProjectId: "b1" }); } catch (error) { thrown4 = error; }
  assert.ok(thrown4 && /要求干净工作树/.test(String(thrown4.message)), String(thrown4 && thrown4.message));
  assert.match(String(thrown4.message), /simple_cluster\/state\/（本扩展的队列\/状态目录）/, "拒绝须提示运行状态目录可用本机 Git 排除规则处理");
  assert.match(String(thrown4.message), /请勿忽略整个 simple_cluster\//, "明确不得忽略可能含科研源码的整个目录");
  assert.match(String(thrown4.message), /不代改 Git 配置/);
  assert.equal(case4.gh.calls.filter(row => row.args.startsWith("pr view") || row.args.startsWith("pr merge")).length, 0, "dirty 拦停＝零写入零查询");
});

test("C4-R6 UI 真实入口祖先 ff：确认后 origin 被改到共享历史的 fork B 不被 live 重读洗白，fetch/merge 前即拦停；冻结 expected 不误伤正常路径", async () => {
  const ancRoot = fs.realpathSync(makeRepo("r6-drift"));
  const aBare = tempDir("se-r6-A-"); git(["init", "-q", "--bare", "-b", "main"], aBare);
  const url = "https://github.com/org/repo.git";
  git(["remote", "add", "origin", url], ancRoot); // origin 只保留正常 GitHub 元数据；不为 fixture 改写全局/仓库 insteadOf
  commitFile(ancRoot, "mainline.txt", "m1\n", "mainline c1");
  git(["push", "-q", aBare, "main"], ancRoot); // 直接写本地裸仓，不经 origin；GitHub 地址零接触（此前 url.<bare>.insteadOf=https://github.com/org/repo 因缺 .git 不匹配，push exit128）
  const bBare = tempDir("se-r6-B-");
  git(["clone", "-q", "--bare", aBare, bBare], os.tmpdir());
  const bHeadBefore = git(["rev-parse", "refs/heads/main"], bBare).trim();
  const env = uiEnv({});
  let flipped = false;
  env.answer = (title) => {
    if (title.startsWith("更新本机祖先主线")) {
      if (!flipped) { flipped = true; git(["remote", "set-url", "origin", bBare], ancRoot); } // 用户确认期间 origin 被改到 fork B（含同一合并提交）
      return "确认快进";
    }
    return "知道了";
  };
  const seen = [];
  const networkish = /^(fetch|push|pull|ls-remote|clone|archive|submodule)\b/;
  // 离线边界只替换“产品会发出的那一个 fetch origin <精确 refspec>”的外部传输目标为真实本地裸仓（同 refspec），
  // 其余命令继续真实 Git（get-url/rev-parse/merge/status 都不触网）；其它网络类命令一律拒绝，绝不接触 GitHub。
  env.branchPullRequest = { ...pr, runGitPullRequest: async (args, cwd, stdin) => {
    const line = args.join(" "); seen.push(line);
    if (args[0] === "fetch" && args[1] === "origin") return pr.runGitPullRequest(["fetch", aBare, ...args.slice(2)], cwd, stdin);
    if (networkish.test(line)) throw new Error("离线夹具拒绝其它网络传输命令：git " + line);
    return pr.runGitPullRequest(args, cwd, stdin);
  }, runGh: recordingGit([]).runner };
  const host = makeLegacyUiHost(env);
  const ancestor = { gitRoot: ancRoot, remoteName: "origin", targetBranch: "main" };
  const frozenTarget = pr.normalizeGithubTarget(url);
  const mergeSha = git(["rev-parse", "HEAD"], ancRoot).trim();
  const drifted = await host.confirmAndFastForwardAncestor(ancestor, frozenTarget, mergeSha);
  assert.equal(drifted.status, "blocked", JSON.stringify(drifted));
  assert.match(drifted.reason, /不一致/, JSON.stringify(drifted));
  assert.ok(!drifted.reason.includes(bBare), "原因不回显确认后新出现的 raw 地址：" + drifted.reason);
  assert.ok(!seen.some(line => line.startsWith("fetch")), "漂移在 fetch 前即拦停：" + JSON.stringify(seen));
  assert.ok(!seen.some(line => line.startsWith("merge ")), "绝不代合并");
  assert.equal(git(["rev-parse", "refs/heads/main"], bBare).trim(), bHeadBefore, "B 仓零接触");
  git(["remote", "set-url", "origin", url], ancRoot); // 正常路径：expected 仍是冻结 target，origin 未变
  const clean = await host.confirmAndFastForwardAncestor(ancestor, frozenTarget, mergeSha);
  assert.equal(clean.status, "already-current", JSON.stringify(clean));
  assert.ok(seen.some(line => line.startsWith("fetch origin")), "冻结 expected（displayUrl）与登记 origin（带 .git）规范化同仓：真实 fetch 正常放行");
});
