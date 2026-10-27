/**
 * src/project/BranchPullRequest.ts - 块C4/C5：科研仓 PR 预览/创建与合并后祖先快进（gh/git 执行器注入）。
 *
 * 契约（主控 2026-10-25 R2/R4/R5 更正后）：
 * - 目标=登记祖先真实 origin 规范化：仅支持 GitHub（host 必须 github.com，owner/repo 恰两段，不冒充
 *   GitLab 多层组、不新增平台）；`.git` 只剥后缀不吞整段；含凭证 https 拒绝；登记 URL 无法规范化＝拒绝，
 *   不允许跳过漂移校验；真实祖先 origin 与真实分支 origin 必须核成同一已确认 repo。
 * - gh 一律带完整 `--repo github.com/owner/repo` 选择器，防 GH_HOST 默认重定向到别的托管实例。
 * - gh 2.93 事实：pr create 不支持 --json，成功仅输出 PR URL；创建后必须 gh pr view 只读重查
 *   精确 repo/head SHA/head 分支/base/PR 号才算成功，URL 子串与 stub 伪 JSON 不作数。
 * - 写前复核（R4）：确认后的本地 HEAD 必须仍未变化；push 用 immutable `<已确认SHA>:refs/heads/<branch>`，
 *   绝不 force；gh pr merge 同样 modal 后重查完整 PR 身份并保留 --match-head-commit。
 * - 未知结果不可重放（R5）：每个动作/目标/SHA 的尝试先落 unknown 收据；同 key 不复用不同动作，
 *   未对账收据不覆盖、不清除；unknown 重入只做只读对账——精确证明 push 已落才继续 PR、精确 PR 存在即复用、
 *   精确 MERGED 只走祖先处理；未能确证保持 blocked，绝不重发。账本经注入的短资源事务原子读改写。
 * - 祖先 ff（R4）：独立确认后，真实 root/common-dir/origin repo/目标分支/干净 HEAD 在 fetch 前后各核一次；
 *   ff 目标用已核完整 SHA；要求 目标包含已确认合并提交 且 本机 HEAD 是目标祖先（含 merge 的后续头可安全 ff）；
 *   脏/分叉/身份变化一律停；绝不 reset/stash/切分支。
 * - 本开发轮次不对任何真实科研仓 push/PR/merge：测试全部经注入执行器（Windows 临时 Git 仓 + gh argv 桩）。
 */
import { spawn } from "node:child_process";
import { sanitizeGitEnv } from "./GitIdentityProbe";

export type PullRequestRunner = (args: string[], cwd: string, stdin?: string) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 120_000;
const PR_LIST_LIMIT = 200;
/** 唯一受支持托管平台（新增平台须由主控批准，不在本任务内）。 */
const SUPPORTED_HOST = "github.com";

/** 真实执行器：clean-env 无 shell spawn，原始 Buffer 输出，上限/超时失败关闭。 */
export function makeRunner(binary: "git" | "gh", timeoutMs: number): PullRequestRunner {
  return (args, cwd, stdin) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env: sanitizeGitEnv(process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { reject(error); return; }
    const chunks: Buffer[] = [];
    let bytes = 0; let overflow = false; let stderr = "";
    const timer = setTimeout(() => { overflow = true; try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) { overflow = true; try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (overflow) reject(new Error(`${binary} 输出超过上限或超时，按未知处理。`));
      else resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 600) });
    });
    child.stdin.on("error", () => undefined);
    if (stdin === undefined) child.stdin.end(); else child.stdin.end(stdin);
  });
}
export const runGitPullRequest: PullRequestRunner = makeRunner("git", GIT_TIMEOUT_MS);
export const runGh: PullRequestRunner = makeRunner("gh", GH_TIMEOUT_MS);

export type GithubTarget = { host: string; owner: string; repo: string; repoSelector: string; displayUrl: string };

/** 仅规范化 GitHub 两段仓库；只剥 `.git` 后缀；ssh:// 端口与登录名解析忽略；其它平台/异常形态一律拒绝。 */
export function normalizeGithubTarget(rawUrl: string): GithubTarget | undefined {
  const raw = String(rawUrl || "").trim();
  if (!raw || /[\s\x00-\x1f]/.test(raw)) return undefined;
  let host = ""; let pathPart = "";
  if (/^(https?|ssh):\/\//i.test(raw)) {
    let url; try { url = new URL(raw); } catch { return undefined; }
    if (!/^https?:$/.test(url.protocol) && !/^ssh:$/.test(url.protocol)) return undefined;
    if (url.password) return undefined; // 任何协议的显式 URL.password 一律拒绝（含 ssh://user:password@）；SSH 正常登录名（git@）仍可用
    if (/^https?:$/.test(url.protocol) && url.username) return undefined; // https 的用户名（含 token 形态）沿用既有拒绝契约
    if (url.port && url.port !== (url.protocol === "ssh:" ? "22" : "")) return undefined; // github.com 非默认/未知端口不得忽略后冒称标准端点（显式 22/隐式 443 仍是默认）
    host = url.hostname.toLowerCase(); pathPart = url.pathname;
  } else {
    const match = /^(?:[^@/\s]+@)?([^:/\s]+)[:/](.+)$/.exec(raw);
    if (!match) return undefined;
    host = match[1].toLowerCase(); pathPart = "/" + match[2];
  }
  if (host !== SUPPORTED_HOST) return undefined; // 不支持的托管平台：明确拒绝（不重定向、不猜测）
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined; // GitHub 仓库恰为 owner/repo 两段
  const last = segments[1];
  if (last.toLowerCase().endsWith(".git")) segments[1] = last.slice(0, -4);
  if (segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..")) return undefined;
  const owner = segments[0]; const repo = segments[1];
  if (!owner || !repo) return undefined;
  return { host: SUPPORTED_HOST, owner, repo, repoSelector: `${SUPPORTED_HOST}/${owner}/${repo}`, displayUrl: `${"https"}://${SUPPORTED_HOST}/${owner}/${repo}` };
}

/** GitHub 仓库/分支比较口径：owner/repo 大小写保留原样但身份比较不敏感；分支引用名大小写敏感。 */
const sameRepo = (a?: GithubTarget, b?: GithubTarget) => Boolean(a && b && a.displayUrl.toLowerCase() === b.displayUrl.toLowerCase());

/**
 * R4：确认“有效推送目标”集合——`git push <remote>` 实际可能走 remote.origin.pushurl 或
 * pushInsteadOf 改写后的地址；用 Git 现成只读命令 `remote get-url --push --all <remote>` 展开真实写目标，
 * 要求每个目标都能规范化为已确认仓库。多目标（无法保证单目标原子语义）、未知/含凭据、或与确认仓不同——
 * 一律拒绝且不改动用户配置。错误只给剥凭据的规范化目标或类别，绝不回显 raw URI。
 */
export async function resolveConfirmedPushTargets(git: PullRequestRunner, cwd: string, remoteName: string, confirmed: GithubTarget): Promise<{ ok: boolean; reason?: string; target?: GithubTarget; selector?: string }> {
  const query = await git(["remote", "get-url", "--push", "--all", remoteName], cwd);
  if (query.code !== 0) return { ok: false, reason: `无法读取 ${remoteName} 的有效推送目标（remote get-url --push --all exit ${query.code}），按未知拒绝写入。` };
  const urls = query.stdout.toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!urls.length) return { ok: false, reason: `${remoteName} 的有效推送目标为空（配置异常），按未知拒绝写入。` };
  const targets = urls.map(normalizeGithubTarget);
  if (targets.some(row => !row)) return { ok: false, reason: "有效推送目标包含无法规范化/含凭据/非 GitHub 的地址（不显示原文），拒绝写入。" };
  const selectors = [...new Set(targets.map(row => row!.repoSelector.toLowerCase()))];
  if (selectors.length > 1) return { ok: false, reason: `${remoteName} 的有效推送目标展开为 ${selectors.length} 个不同仓库，无法保证单目标确认语义，拒绝写入（不会替你改写 Git 配置）。` };
  if (!sameRepo(targets[0], confirmed)) return { ok: false, reason: `有效推送目标（${targets[0]!.displayUrl}）与已确认仓库不一致（如 pushurl/insteadOf 改写），拒绝写入。` };
  return { ok: true, target: targets[0], selector: selectors[0] };
}

/** stderr 分类：仅命中已知“写请求确定未执行/被拒”特征才算 definite-failed，其余非零一律 unknown（保守，不重放）。 */
const DEFINITE_REJECT_PATTERNS = [/\((?:non-fast-forward|fetch first|stale info)\)/i, /rejected/i, /already exists/i, /must be reviewed/i, /could not (?:read from remote repository|find repository|resolve)/i, /invalid argument|unknown flag|unknown argument/i, /protected branch/i, /permission denied \(/i];
export function classifyWriteFailure(stderr: string, exception?: unknown): "definite-failed" | "unknown" {
  if (exception) return "unknown";
  const text = String(stderr || "");
  return DEFINITE_REJECT_PATTERNS.some(pattern => pattern.test(text)) ? "definite-failed" : "unknown";
}

/** gh 2.93 真实形状：headRepositoryOwner={id,login}、headRepository={id,name,nameWithOwner}；解析为 login 与 nameWithOwner。 */
export type PrListRow = { number: number; state?: string; isDraft?: boolean; headRefOid?: string; headRefName?: string; headRepositoryOwner?: string; headRepository?: string; baseRefOid?: string; baseRefName?: string; url?: string };
const PR_JSON_FIELDS = "number,state,isDraft,headRefOid,headRefName,headRepository,headRepositoryOwner,baseRefOid,baseRefName,url";

function ownerLoginOf(value: any): string | undefined {
  const login = value?.headRepositoryOwner?.login;
  return login ? String(login) : undefined;
}
function headRepoOf(value: any): string | undefined {
  const nameWithOwner = value?.headRepository?.nameWithOwner;
  return nameWithOwner ? String(nameWithOwner) : undefined;
}

function toPrRow(row: any): PrListRow {
  return {
    number: Number(row?.number), state: row?.state ? String(row.state) : undefined, isDraft: Boolean(row?.isDraft),
    headRefOid: row?.headRefOid ? String(row.headRefOid) : undefined, headRefName: row?.headRefName ? String(row.headRefName) : undefined,
    headRepositoryOwner: ownerLoginOf(row), headRepository: headRepoOf(row),
    baseRefOid: row?.baseRefOid ? String(row.baseRefOid) : undefined, baseRefName: row?.baseRefName ? String(row.baseRefName) : undefined,
    url: row?.url ? String(row.url) : undefined,
  };
}

export function parsePrList(stdoutText: string): PrListRow[] {
  const parsed = JSON.parse(String(stdoutText || "").trim());
  if (!Array.isArray(parsed)) throw new Error("gh pr list 返回不是数组");
  return parsed.map(toPrRow).filter(row => Number.isInteger(row.number) && row.number > 0);
}

export type PrClassification = { kind: "none" | "reuse" | "updates-existing" | "merged" | "unknown"; pr?: PrListRow; note: string };

/**
 * 列表 → 分类（R2 精确身份）：以 headRefName===分支（大小写敏感）∧headRepositoryOwner===owner（不敏感，
 * fork 的 PR 属“其它创新 PR”不算本分支）∧baseRefName===base 为准；同 base 其它分支/同 SHA 其它分支只记注不匹配；
 * 截断或解析失败＝unknown（不得假唯一/不存在）。
 */
export function classifyPrRows(rows: PrListRow[], truncated: boolean, options: { owner: string; repo: string; branch: string; base: string; sourceSha: string }): PrClassification {
  if (truncated) return { kind: "unknown", note: `PR 列表达到 ${PR_LIST_LIMIT} 上限可能被截断，无法确证该分支的 PR 状态` };
  const open = (row: PrListRow) => (row.state || "OPEN").toUpperCase() === "OPEN";
  const mergedState = (row: PrListRow) => (row.state || "").toUpperCase() === "MERGED";
  // 引用名（branch/base）严格按原值大小写敏感；GitHub owner/repo 与 SHA 身份比较不敏感；head 仓库必须来自真实对象身份。
  const ours = (row: PrListRow) => (row.headRefName || "") === options.branch
    && String(row.headRepositoryOwner || "").toLowerCase() === options.owner.toLowerCase()
    && String(row.headRepository || "").toLowerCase() === `${options.owner}/${options.repo}`.toLowerCase()
    && (row.baseRefName || "") === options.base;
  const exactSha = (row: PrListRow) => (row.headRefOid || "").toLowerCase() === options.sourceSha.toLowerCase();
  const exactOpen = rows.filter(row => open(row) && ours(row)).sort((a, b) => b.number - a.number);
  const exactMerged = rows.filter(row => mergedState(row) && ours(row));
  const otherOpenSameBase = rows.filter(row => open(row) && !ours(row) && (row.baseRefName || "") === options.base
    && (row.headRefOid || "").toLowerCase() === options.sourceSha.toLowerCase());
  const identityHit = exactOpen.find(exactSha);
  if (identityHit) return { kind: "reuse", pr: identityHit, note: `开放 PR #${identityHit.number} 的 head 仓库/分支/base/SHA 与本候选一致${identityHit.isDraft ? "（草稿）" : ""}，按身份复用即可` };
  const mergedExact = exactMerged.find(exactSha);
  if (exactOpen.length === 0 && mergedExact) return { kind: "merged", pr: mergedExact, note: `本候选（head SHA 全匹配）在 ${options.branch} → ${options.base} 上已有 MERGED PR #${mergedExact.number}：无需再推送/创建/合并，只做祖先处理` };
  if (exactOpen.length) {
    const row = exactOpen[0];
    return { kind: "updates-existing", pr: row, note: `本分支相对 ${options.base} 已有开放 PR #${row.number}（head ${String(row.headRefOid).slice(0, 10)} ≠ 本候选 ${options.sourceSha.slice(0, 10)}）：确认后普通推送将更新该 PR，随后重查按身份复用，绝不盲目 pr create` };
  }
  const historyNotes: string[] = [];
  if (exactMerged.length) historyNotes.push(`历史 MERGED PR（另一候选）：#${exactMerged.map(row => `${row.number}(${String(row.headRefOid).slice(0, 8)})`).join(", ")}——SHA 与本候选不同，不构成当前候选已合并`);
  if (otherOpenSameBase.length) historyNotes.push(`存在指向 ${options.base} 的其它创新 PR（#${otherOpenSameBase.map(row => row.number).join(", ")}，分支不同），非本分支 PR`);
  return { kind: "none", note: historyNotes.length ? historyNotes.join("；") : `该分支相对 ${options.base} 没有任何 PR（open/merged 全量核对）` };
}

export type PrPreview = {
  ok: boolean; reason?: string;
  target?: GithubTarget;
  remoteName?: string; base?: string; branch?: string; sourceSha?: string; baseSha?: string;
  /** 已确证的唯一有效推送目标（规范化 selector）；确认后变化＝写前复核失败。 */
  pushRepo?: string;
  baseState?: "found" | "missing" | "unknown";
  branchRemoteSha?: string;
  existing?: PrClassification;
  divergence?: { ahead: number; behind: number } | "unknown";
  digest?: string;
};

/** 只读预览：真实 origin 规范化+登记核对 → ls-remote 基线/分支头 → 本地 ahead/behind（无基线如实 unknown）→ gh pr list（state all）精确分类。 */
export async function previewBranchPullRequest(options: {
  git: PullRequestRunner; gh?: PullRequestRunner;
  cwd: string; remoteName: string; registeredRemoteUrl: string; branch: string; base: string; sourceSha: string;
}): Promise<PrPreview> {
  const { git, gh, cwd, remoteName, registeredRemoteUrl, branch, base, sourceSha } = options;
  const fail = (reason: string): PrPreview => ({ ok: false, reason, existing: { kind: "unknown", note: "未查询" } });
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || /^[.-]/.test(branch) || branch.includes("..")) return fail("分支名不符合 Git 引用规则，拒绝任何远端操作。");
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || /^[.-]/.test(base) || base.includes("..")) return fail("目标分支名不符合 Git 引用规则。");
  if (!/^[0-9a-f]{40}$/i.test(String(sourceSha || ""))) return fail("源提交 SHA 无效（需要完整 40 位），未查询远端。");
  const remoteShow = await git(["remote", "get-url", remoteName], cwd);
  if (remoteShow.code !== 0) return fail(`本地不存在远端 ${remoteName}（登记祖先可能已改动 remote），未查询。`);
  const live = normalizeGithubTarget(remoteShow.stdout.toString("utf8"));
  const registered = normalizeGithubTarget(registeredRemoteUrl);
  if (!live) return fail("当前 origin URL 无法规范化为 GitHub 仓库目标（非 github.com、含凭证或形态异常），按未知停止，不猜测。");
  if (!registered) return fail("登记祖先的 origin 无法规范化（非 github.com 或含凭证）：无法执行漂移校验，拒绝操作。请重新登记祖项目标。");
  if (!sameRepo(live, registered)) return fail(`实际 origin（${live.displayUrl}）与登记祖先（${registered.displayUrl}）不是同一已确认仓库——目标漂移，请重新登记祖先后再操作。`);
  // fetch 地址一致不代表 push 地址一致：pushurl/pushInsteadOf 可指向另一仓，任何不可确证的写目标都拒绝。
  const pushTargets = await resolveConfirmedPushTargets(git, cwd, remoteName, live);
  if (!pushTargets.ok) return fail(pushTargets.reason || "有效推送目标无法确证。");
  const baseQuery = await git(["ls-remote", "--heads", remoteName, base], cwd);
  if (baseQuery.code !== 0) return fail(`目标分支查询失败（${baseQuery.stderr.slice(0, 160) || `exit ${baseQuery.code}`}），按未知停止。`);
  const baseLine = baseQuery.stdout.toString("utf8").split(/\r?\n/).map(line => line.split("\t")).filter(parts => parts[1] === `refs/heads/${base}`)[0];
  const branchQuery = await git(["ls-remote", "--heads", remoteName, branch], cwd);
  if (branchQuery.code !== 0) return fail(`分支头查询失败（${branchQuery.stderr.slice(0, 160) || `exit ${branchQuery.code}`}），按未知停止。`);
  const branchLine = branchQuery.stdout.toString("utf8").split(/\r?\n/).map(line => line.split("\t")).filter(parts => parts[1] === `refs/heads/${branch}`)[0];
  let divergence: PrPreview["divergence"] = "unknown";
  try {
    const counts = await git(["rev-list", "--count", "--left-right", `refs/remotes/${remoteName}/${base}...${sourceSha}`], cwd);
    if (counts.code === 0) {
      const parts = counts.stdout.toString("utf8").trim().split(/\s+/).map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) divergence = { behind: parts[0], ahead: parts[1] };
    }
  } catch { /* 保持 unknown */ }
  const preview: PrPreview = {
    ok: true, target: live, remoteName, base, branch, sourceSha: sourceSha.toLowerCase(), pushRepo: pushTargets.selector,
    baseSha: baseLine ? baseLine[0].toLowerCase() : undefined, baseState: baseLine ? "found" : (baseQuery.stdout.toString("utf8").trim() ? "unknown" : "missing"),
    branchRemoteSha: branchLine ? branchLine[0].toLowerCase() : "",
    divergence, existing: { kind: "unknown", note: "未配置 gh，无法确认既有 PR" },
  };
  if (preview.baseState === "missing") preview.existing = { kind: "unknown", note: `目标分支 ${base} 在远端不存在，不能创建 PR` };
  if (!gh || preview.baseState !== "found") { preview.digest = digestPreview(preview); return preview; }
  const listed = await gh(["pr", "list", "--repo", live.repoSelector, "--state", "all", "--json", PR_JSON_FIELDS, "--limit", String(PR_LIST_LIMIT)], cwd);
  if (listed.code !== 0) { preview.existing = { kind: "unknown", note: `PR 列表查询失败：${(listed.stderr || "").slice(0, 160) || `exit ${listed.code}`}` }; preview.digest = digestPreview(preview); return preview; }
  try {
    const rows = parsePrList(listed.stdout.toString("utf8"));
    preview.existing = classifyPrRows(rows, rows.length >= PR_LIST_LIMIT, { owner: live.owner, repo: live.repo, branch, base, sourceSha: sourceSha.toLowerCase() });
  } catch (error) {
    preview.existing = { kind: "unknown", note: `PR 列表不可解析，按未知停止：${String((error as Error)?.message || error).slice(0, 160)}` };
  }
  preview.digest = digestPreview(preview);
  return preview;
}

function digestPreview(preview: PrPreview): string {
  return JSON.stringify([preview.target?.displayUrl.toLowerCase() || "", preview.remoteName, preview.base, preview.branch, preview.sourceSha,
    preview.pushRepo || "", preview.baseState, preview.baseSha || "", preview.branchRemoteSha || "", preview.existing?.kind, preview.existing?.pr?.number ?? null, String(preview.divergence)]);
}

export type Receipt = { key: string; root: string; branch: string; sourceSha: string; base: string; repoSelector: string;
  action: "push" | "pr-create" | "merge"; attemptAt: string; outcome: "ok" | "definite-failed" | "unknown"; detail?: string; prNumber?: number;
  /** 本次尝试的独立身份：settle 只更新自己的行，绝不 filter(key) 吞掉同键其它尝试或旧 unknown。 */
  attemptId?: string };
/** 账本契约：load/save 原子对；withLock（若提供）把一次读-改-写放进同一短资源事务，防多窗口互相丢写。key 必含 action。 */
export type ReceiptLedger = { load(): Promise<Receipt[]>; save(rows: Receipt[]): Promise<void>; withLock?<T>(fn: () => Promise<T>): Promise<T> };

/** 修剪策略（R5）：未对账 unknown 收据永不修剪；已结收据只留最近 200 条。 */
export function pruneReceipts(rows: Receipt[]): Receipt[] {
  const unresolved = rows.filter(row => row.outcome === "unknown");
  const settled = rows.filter(row => row.outcome !== "unknown").slice(-200);
  return [...unresolved, ...settled];
}

/** 租约/收据用的工作目录规范形（大小写与分隔符不敏感、去尾分隔符）；仅用于身份键，不改展示字段。 */
export function normalizeReceiptRoot(root: string): string {
  return String(root || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function inLedger<T>(ledger: ReceiptLedger, fn: () => Promise<T>): Promise<T> {
  return ledger.withLock ? ledger.withLock(fn) : fn();
}

/**
 * R5a 写前落 unknown 收据：同一远端操作语义身份（key＝repoSelector 规范化＋动作＋分支＋SHA＋base，
 * 与 cwd 拼写无关）下只要存在任何未对账尝试就原子拒绝（不再只挡“更新的时间戳”）；不同动作/仓库不受牵连。
 * settle 按 attemptId 精确结算自己的行；同键其它尝试与其它键的 unknown 一律原样保留。
 */
async function openReceipt(ledger: ReceiptLedger, fields: Omit<Receipt, "outcome" | "attemptAt">): Promise<{ row: Receipt; settle(outcome: Receipt["outcome"], detail?: string, prNumber?: number): Promise<void> }> {
  const row: Receipt = { ...fields, attemptAt: new Date().toISOString(), outcome: "unknown", attemptId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
  await inLedger(ledger, async () => {
    const rows = await ledger.load();
    if (rows.some(item => item.key === row.key && item.outcome === "unknown")) throw new Error("同一远端操作已有未对账尝试（任何时间戳），拒绝再次落盘；先只读对账。");
    await ledger.save(pruneReceipts([...rows, row]));
  });
  return { row, settle: async (outcome, detail, prNumber) => {
    try {
      await inLedger(ledger, async () => {
        const latest = await ledger.load();
        const settled = { ...row, outcome, detail: String(detail || "").slice(0, 400), prNumber };
        const owned = latest.some(item => item.attemptId && item.attemptId === row.attemptId);
        await ledger.save(pruneReceipts(owned
          ? latest.map(item => item.attemptId === row.attemptId ? settled : item)
          : [...latest.filter(item => item.key !== row.key || item.outcome === "unknown"), settled]));
      });
    } catch { /* 保留先前 unknown 收据：宁可多一次人工对账，不制造可重放假象 */ }
  } };
}

export async function loadUnknownReceipts(ledger: ReceiptLedger): Promise<Receipt[]> {
  const rows = await inLedger(ledger, () => ledger.load());
  return rows.filter(row => row.outcome === "unknown");
}

export type CreateResult = { status: "created" | "reused" | "already-merged" | "blocked-unknown" | "blocked-verification" | "failed"; prNumber?: number; url?: string; reason?: string; note?: string };

function remoteHeadOf(stdout: Buffer, branch: string): string {
  const line = stdout.toString("utf8").split(/\r?\n/).map(row => row.split("\t")).filter(parts => parts[1] === `refs/heads/${branch}`)[0];
  return line ? line[0].toLowerCase() : "";
}

/** gh 2.93：pr create 无 --json，成功仅输出 URL 行；只接受整行精确匹配。 */
function parseCreatedPrUrl(stdoutText: string, target: GithubTarget): number | undefined {
  for (const line of String(stdoutText || "").split(/\r?\n/)) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(line.trim());
    if (!match) continue;
    if (match[1].toLowerCase() !== target.owner.toLowerCase() || match[2].toLowerCase() !== target.repo.toLowerCase()) continue;
    return Number(match[3]);
  }
  return undefined;
}

/** 只读核验 PR 身份（view；失败回退 list 对账）。 */
async function verifyPrIdentity(gh: PullRequestRunner, cwd: string, target: GithubTarget, number: number, sourceSha: string, base: string, branch: string): Promise<PrListRow | undefined> {
  try {
    const view = await gh(["pr", "view", String(number), "--repo", target.repoSelector, "--json", PR_JSON_FIELDS], cwd);
    if (view.code === 0) {
      const value = JSON.parse(view.stdout.toString("utf8"));
      const row = toPrRow(value);
      if (row.number === number && (row.headRefOid || "").toLowerCase() === sourceSha.toLowerCase() && (row.baseRefName || "") === base
        && (row.headRefName || "") === branch && String(row.headRepositoryOwner || "").toLowerCase() === target.owner.toLowerCase()
        && String(row.headRepository || "").toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()) return row;
    }
  } catch { /* 继续 list 对账 */ }
  try {
    const listed = await gh(["pr", "list", "--repo", target.repoSelector, "--state", "all", "--json", PR_JSON_FIELDS, "--limit", String(PR_LIST_LIMIT)], cwd);
    if (listed.code !== 0) return undefined;
    const rows = parsePrList(listed.stdout.toString("utf8"));
    if (rows.length >= PR_LIST_LIMIT) return undefined;
    return rows.find(row => row.number === number && (row.headRefOid || "").toLowerCase() === sourceSha.toLowerCase()
      && (row.baseRefName || "") === base && (row.headRefName || "") === branch
      && String(row.headRepositoryOwner || "").toLowerCase() === target.owner.toLowerCase()
      && String(row.headRepository || "").toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase());
  } catch { return undefined; }
}

/**
 * 创建/复用 PR（调用方已完成 modal 确认）。步骤＝unknown 收据只读对账 → 写前复核（digest+本地 HEAD 未变）→
 * 普通推送（immutable SHA，仅当远端缺该 SHA）→ gh pr create（真实 CLI 形态）→ 只读核验。任何未确证＝blocked，不重发。
 */
export type CreateBranchPullRequestOptions = {
  git: PullRequestRunner; gh: PullRequestRunner; ledger: ReceiptLedger;
  cwd: string; remoteName: string; registeredRemoteUrl: string; branch: string; base: string; sourceSha: string;
  title: string; body: string; previewDigest: string;
  /** R3：每次不可逆写入前由调用方用同一校验器重读身份＋队列（撤证/命令/版本变化、manifest 缺失＝拒绝）。 */
  revalidate?: () => Promise<{ ok: boolean; reason?: string }>;
  /** R5b：C4 专用“仓/引用操作租约”，覆盖确认后复核→网络写入→结清全程；等待型互斥，第二进入者拿到租约后完整重读。 */
  withRepoLease?: <T>(leaseId: string, fn: () => Promise<T>) => Promise<T>;
};
export async function createBranchPullRequest(options: CreateBranchPullRequestOptions): Promise<CreateResult> {
  if (options.withRepoLease) {
    // R5 统一操作身份：租约资源＝规范化已确认仓（GitHub owner/repo 大小写不敏感）＋实际 head 引用（refs 严格大小写原值）。
    // 绝不含 cwd/base——不同完整 clone、大小写或路径拼写、不同 base 的同一 repo/ref 必须落在同一把锁上；不同仓/不同 head ref 仍可并行。
    // 已确认地址无法规范化＝未知 target，先拒（不拿 cwd 当“临时替代”，也不无锁放行）。create 与 merge 同一条规则。
    const leaseRepo = normalizeGithubTarget(options.registeredRemoteUrl);
    if (!leaseRepo)
      return { status: "blocked-unknown", reason: "已确认仓库地址无法规范化：无法建立安全的仓/引用操作互斥身份，拒绝执行（不以工作目录代替，零写入）。" };
    return options.withRepoLease(`branch-pr-op:${leaseRepo.repoSelector.toLowerCase()}:${options.branch}`, () => createBranchPullRequestLeased(options));
  }
  return createBranchPullRequestLeased(options);
}
async function createBranchPullRequestLeased(options: CreateBranchPullRequestOptions): Promise<CreateResult> {
  const { git, gh, ledger, cwd, remoteName, branch, base, sourceSha, title, body, previewDigest } = options;
  const targetKey = [cwd, branch, sourceSha.toLowerCase(), base];
  let unknowns: Receipt[];
  // 语义身份与 cwd 无关：任何未对账的同操作收据（哪怕登记在别的工作目录拼写/大小写下）都进入对账视野。
  try { unknowns = (await loadUnknownReceipts(ledger)).filter(row => row.branch === branch
    && String(row.sourceSha).toLowerCase() === sourceSha.toLowerCase() && row.base === base); }
  catch (error) { return { status: "blocked-unknown", reason: `收据账本不可读/已损坏（${String((error as Error)?.message || error).slice(0, 160)}），无法确认是否存在未对账写入，拒绝任何写入。` }; }
  const preview = await previewBranchPullRequest({ git, gh, cwd, remoteName, registeredRemoteUrl: options.registeredRemoteUrl, branch, base, sourceSha });
  if (!preview.ok) return { status: "blocked-unknown", reason: `写前复核未通过：${preview.reason}`, note: unknowns.length ? "存在未对账的写操作收据，未重试任何写入。" : "" };
  if (preview.digest !== previewDigest) return { status: "blocked-unknown", reason: "写前复核与确认时的预览不一致（远端或本地状态已变化），本次未写入任何内容。请重新预览并确认。" };
  const target = preview.target!;
  if (preview.baseState !== "found") return { status: "blocked-unknown", reason: "目标基线在写前复核时不可确定，未写入。" };
  // R5：unknown 收据先只读对账——只有精确证明已落地才继续，且每种动作只补做“确证未发生”的后继步骤。
  const pushUnknown = unknowns.find(row => row.key === receiptKey(targetKey, "push", target.repoSelector));
  if (pushUnknown && pushUnknown.outcome === "unknown") {
    if ((preview.branchRemoteSha || "") !== preview.sourceSha)
      return { status: "blocked-unknown", reason: `存在未对账的 push 收据且远端 ${branch} 当前头无法精确证明该次推送已落地/未落地；不重发，请稍后重新预览对账（若已在网页处理，可用“合并PR”只读恢复）。` };
    await (await openReceiptResolved(ledger, pushUnknown)).settle("ok", "只读对账：远端分支头恰等于该收据的源 SHA");
  }
  const prUnknown = unknowns.find(row => row.key === receiptKey(targetKey, "pr-create", target.repoSelector));
  if (prUnknown && prUnknown.outcome === "unknown") {
    if (preview.existing?.kind === "none") return { status: "blocked-unknown", reason: "存在未对账的 pr-create 收据，只读核对未能精确证明其已建/未建；不重发。可稍后重试（仅只读对账）或在网页确认后再操作。" };
    if (preview.existing?.kind === "merged" && preview.existing.pr) {
      await (await openReceiptResolved(ledger, prUnknown)).settle("ok", "只读对账：PR 已 MERGED", preview.existing.pr.number);
      return { status: "already-merged", prNumber: preview.existing.pr.number, url: preview.existing.pr.url, note: "只读对账确认该 PR 已 MERGED：不重发任何写入，仅需（经独立确认后）做祖先快进。" };
    }
    const found = preview.existing?.pr;
    const exactHit = preview.existing?.kind === "reuse" && found
      && (found.headRefOid || "").toLowerCase() === sourceSha.toLowerCase()
      && (found.baseRefName || "") === base && (found.headRefName || "") === branch;
    if (exactHit && found) {
      await (await openReceiptResolved(ledger, prUnknown)).settle("ok", "只读对账：精确身份+源SHA PR 存在", found.number);
      return { status: "reused", prNumber: found.number, url: found.url, note: "只读对账确认精确身份且 head SHA 等于源 SHA 的 PR 存在，按身份复用；未重发。" };
    }
    return { status: "blocked-unknown", reason: "存在未对账的 pr-create 收据，且只读核对未能证明“精确身份＋源 SHA”的 PR 存在（updates-existing 等其它形态不能视为本收据已落地）；不重发、不假复用。" };
  }
  if (preview.existing?.kind === "unknown")
    return { status: "blocked-unknown", reason: `既有 PR/远端状态未能确定（${preview.existing.note}），本次未写入任何内容。${unknowns.length ? "存在未对账写操作收据：只有只读对账能确定动作时才会继续。" : ""}` };
  if (preview.existing?.kind === "reuse" && preview.existing.pr)
    return { status: "reused", prNumber: preview.existing.pr.number, url: preview.existing.pr.url, note: "按身份复用既有 PR（head 分支/base/SHA 一致），未推送、未新建。" };
  if (preview.existing?.kind === "merged" && preview.existing.pr) {
    const mergedRow = preview.existing.pr;
    return { status: "already-merged", prNumber: mergedRow.number, url: mergedRow.url, note: "该候选在本分支/base 上已有 MERGED PR：不新建；如需更新祖先请走“合并PR”的只读恢复＋独立确认快进。" };
  }
  // R4：本地 HEAD 在确认后不得变化——push 用已确认 immutable SHA。
  const localHead = await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd);
  const localSha = localHead.code === 0 ? localHead.stdout.toString("utf8").trim().toLowerCase() : "";
  if (localSha !== preview.sourceSha)
    return { status: "blocked-unknown", reason: `本地分支 ${branch} 当前头（${localSha ? localSha.slice(0, 10) : "?"}）与确认时的候选（${String(preview.sourceSha).slice(0, 10)}）不一致——确认后本地已变化，零写入停止，不推新提交。` };
  if (options.revalidate) {
    const gate = await Promise.resolve(options.revalidate()).catch(error => ({ ok: false, reason: `复核执行异常：${String((error as Error)?.message || error).slice(0, 160)}` }));
    if (!gate.ok) return { status: "blocked-verification", reason: `写前科研确证复核未通过：${gate.reason || "候选摘要不再成立"}。本次零写入。` };
  }
  if (preview.branchRemoteSha !== preview.sourceSha) {
    // R4：真正 push 前再核一次有效推送目标（pushurl/pushInsteadOf 在确认后可能被改动）；变化＝零写入。
    const pushNow = await resolveConfirmedPushTargets(git, cwd, remoteName, target);
    if (!pushNow.ok || pushNow.selector !== preview.pushRepo)
      return { status: "blocked-unknown", reason: `写前推送目标复核未通过：${pushNow.reason || "有效推送目标在确认后发生变化"}。本次零写入。` };
    let receipt;
    try { receipt = await openReceipt(ledger, { key: receiptKey(targetKey, "push", target.repoSelector), root: cwd, branch, sourceSha: sourceSha.toLowerCase(), base, repoSelector: target.repoSelector, action: "push" }); }
    catch (error) { return { status: "blocked-unknown", reason: `写入前无法落收据（${String((error as Error)?.message || error).slice(0, 160)}）——没有收据就没有“不重放”保证，本次未写入。` }; }
    let push;
    try { push = await git(["push", remoteName, `${preview.sourceSha}:refs/heads/${branch}`], cwd); }
    catch (error) {
      await receipt.settle("unknown", `push 传输异常：${String((error as Error)?.message || error).slice(0, 200)}`);
      return { status: "blocked-unknown", reason: "推送结果未知（连接中断/超时）。收据已记录，系统不会自动重放；请重新预览对账后再决定。" };
    }
    if (push.code !== 0) {
      const kind = classifyWriteFailure(push.stderr);
      await receipt.settle(kind, push.stderr);
      return kind === "definite-failed"
        ? { status: "failed", reason: `推送被远端确定拒绝：${push.stderr.slice(0, 240)}（未创建 PR）` }
        : { status: "blocked-unknown", reason: `推送退出码 ${push.code} 且无法确定是否已写入远端，按未知停止；收据已记录，不自动重放。` };
    }
    const verify = await git(["ls-remote", "--heads", remoteName, branch], cwd);
    if (verify.code !== 0 || remoteHeadOf(verify.stdout, branch) !== preview.sourceSha) {
      await receipt.settle("unknown", "push exit 0 但远端分支头与源 SHA 不符");
      return { status: "blocked-unknown", reason: "推送声称成功但远端分支头与源 SHA 不一致，按未知停止（不重放、不创建 PR）。" };
    }
    await receipt.settle("ok", "远端分支头已核等于源 SHA");
  }
  if (preview.existing?.kind === "updates-existing" && preview.existing.pr) {
    const row = await verifyPrIdentity(gh, cwd, target, preview.existing.pr.number, preview.sourceSha!, base, branch);
    if (!row) return { status: "blocked-unknown", reason: `已普通推送更新分支，但只读重查未能确认 PR #${preview.existing.pr.number} 的 head 已等于该 SHA；不重发创建，请稍后重试对账。`, prNumber: preview.existing.pr.number };
    return { status: "reused", prNumber: row.number, url: row.url, note: "确认后普通推送更新既有开放 PR，随后只读重查按身份复用（未新建 PR）。" };
  }
  if (options.revalidate) {
    const gate = await Promise.resolve(options.revalidate()).catch(error => ({ ok: false, reason: `复核执行异常：${String((error as Error)?.message || error).slice(0, 160)}` }));
    if (!gate.ok) return { status: "blocked-verification", reason: `推送后、创建 PR 前科研确证复核未通过：${gate.reason || "候选摘要不再成立"}。已确证落地的推送保持原样（收据已记），未创建 PR，不重发任何写入。` };
  }
  let prReceipt;
  try { prReceipt = await openReceipt(ledger, { key: receiptKey(targetKey, "pr-create", target.repoSelector), root: cwd, branch, sourceSha: sourceSha.toLowerCase(), base, repoSelector: target.repoSelector, action: "pr-create" }); }
  catch (error) { return { status: "blocked-unknown", reason: `创建 PR 前无法落收据（${String((error as Error)?.message || error).slice(0, 160)}），未执行任何写入。` }; }
  let created;
  try { created = await gh(["pr", "create", "--repo", target.repoSelector, "--head", branch, "--base", base, "--title", title, "--body", body], cwd); }
  catch (error) {
    await prReceipt.settle("unknown", `gh 传输异常：${String((error as Error)?.message || error).slice(0, 200)}`);
    return { status: "blocked-unknown", reason: "创建 PR 结果未知（gh 连接中断/超时）。收据已记录，不自动重放；再次操作将先只读对账。" };
  }
  if (created.code !== 0) {
    const kind = classifyWriteFailure(created.stderr);
    await prReceipt.settle(kind, created.stderr);
    return kind === "definite-failed"
      ? { status: "failed", reason: `gh 确定拒绝创建 PR：${created.stderr.slice(0, 240)}` }
      : { status: "blocked-unknown", reason: `创建 PR 退出码 ${created.code} 无法判定是否已建，按未知停止（不重放）。` };
  }
  const number = parseCreatedPrUrl(created.stdout.toString("utf8"), target);
  if (!number) {
    const viaList = await gh(["pr", "list", "--repo", target.repoSelector, "--state", "open", "--json", PR_JSON_FIELDS, "--limit", String(PR_LIST_LIMIT)], cwd).catch(() => undefined);
    let found: PrListRow | undefined;
    if (viaList && viaList.code === 0) {
      try {
        const rows = parsePrList(viaList.stdout.toString("utf8"));
        found = rows.length < PR_LIST_LIMIT ? rows.find(row => (row.headRefOid || "").toLowerCase() === preview.sourceSha && (row.baseRefName || "") === base
          && (row.headRefName || "") === branch && String(row.headRepositoryOwner || "").toLowerCase() === target.owner.toLowerCase()
          && String(row.headRepository || "").toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()) : undefined;
      } catch { /* 未知 */ }
    }
    if (found) { await prReceipt.settle("ok", "输出非 URL 行但只读对账确认已建", found.number); return { status: "reused", prNumber: found.number, url: found.url, note: "gh 输出异常，但只读对账确认 PR 已存在，按身份复用。" }; }
    await prReceipt.settle("unknown", "gh 成功退出但输出无精确 PR URL 且对账未见对应 PR");
    return { status: "blocked-unknown", reason: "创建 PR 返回无法核验身份且对账未见对应 PR，按未知停止；收据已记录，不自动重放。" };
  }
  const verified = await verifyPrIdentity(gh, cwd, target, number, preview.sourceSha!, base, branch);
  if (!verified) {
    await prReceipt.settle("unknown", `URL 显示 #${number} 但只读核验身份不一致/不可读`);
    return { status: "blocked-unknown", reason: `gh 输出指向 PR #${number}，但只读核验其 repo/head SHA/head 分支/base 未全部一致；按未知停止，不宣称成功。` };
  }
  await prReceipt.settle("ok", "gh 输出 URL 且只读核验 repo/head 分支/SHA/base 全部一致", number);
  return { status: "created", prNumber: number, url: verified.url };
}

/** 只读对账后的结清：只落这一条确证尝试（attemptId 优先，旧记录退回“同键+unknown”单条），其它行原样保留。 */
async function openReceiptResolved(ledger: ReceiptLedger, prior: Receipt): Promise<{ settle(outcome: Receipt["outcome"], detail?: string, prNumber?: number): Promise<void> }> {
  return { settle: async (outcome, detail, prNumber) => {
    try {
      await inLedger(ledger, async () => {
        const rows = await ledger.load();
        const settled = { ...prior, outcome, detail: String(detail || "").slice(0, 400), prNumber };
        let hit = false;
        const next = rows.map(item => {
          const match = prior.attemptId ? item.attemptId === prior.attemptId : item.key === prior.key && item.outcome === "unknown";
          if (!match || hit) return item;
          hit = true;
          return settled;
        });
        await ledger.save(pruneReceipts(hit ? next : [...rows, settled]));
      });
    } catch { /* 保留原 unknown */ }
  } };
}

export type MergeResult = { status: "merged" | "not-merged" | "blocked-unknown" | "blocked-verification"; mergeCommit?: string; state?: string; reason?: string };

type PrView = { row: PrListRow; mergeCommit: string };
async function viewPrState(gh: PullRequestRunner, cwd: string, repoSelector: string, prNumber: number): Promise<PrView | undefined> {
  try {
    const view = await gh(["pr", "view", String(prNumber), "--repo", repoSelector, "--json", `state,mergedAt,mergeCommit,${PR_JSON_FIELDS}`], cwd);
    if (view.code !== 0) return undefined;
    const value = JSON.parse(view.stdout.toString("utf8"));
    return { row: toPrRow(value), mergeCommit: String(value?.mergeCommit?.oid || "") };
  } catch { return undefined; }
}

/**
 * C5 合并（调用方 modal 确认后）：先只读重查完整 PR 身份（含已在网页 MERGED 的恢复路径）；
 * unknown merge 收据只读对账不重发；仅 --merge + --match-head-commit；退出码不作结论，
 * 必须再 view 到 MERGED+mergeCommit。
 */
export type MergeBranchPullRequestOptions = {
  gh: PullRequestRunner; ledger: ReceiptLedger; cwd: string; repoSelector: string; prNumber: number; verifiedHeadSha: string; base: string; branch: string;
  /** R3：合并写指令发出前由调用方用同一校验器重读身份＋队列。 */
  revalidate?: () => Promise<{ ok: boolean; reason?: string }>;
  /** R5b：同 create——覆盖只读重查→合并指令→复核结清全程的专用租约；身份规则与 create 完全一致：
   * 规范化已确认仓（大小写不敏感）＋实际 head 引用（严格大小写原值），不含 cwd/PR 号之外可漂移成分。 */
  withRepoLease?: <T>(leaseId: string, fn: () => Promise<T>) => Promise<T>;
  /** MERGED 只读恢复模式：仅允许“view 已 MERGED 且完整身份与本候选全等（含 40 位 mergeCommit.oid）”的对账捷径；
   * OPEN/CLOSED/未知/身份不符/读不到一律如实 blocked——代码路径上绝不进入 gh pr merge。 */
  readOnly?: boolean;
};
export async function mergeBranchPullRequest(options: MergeBranchPullRequestOptions): Promise<MergeResult> {
  if (options.withRepoLease)
    return options.withRepoLease(`branch-pr-op:${String(options.repoSelector).toLowerCase()}:${options.branch}`, () => mergeBranchPullRequestLeased(options));
  return mergeBranchPullRequestLeased(options);
}
async function mergeBranchPullRequestLeased(options: MergeBranchPullRequestOptions): Promise<MergeResult> {
  const { gh, ledger, cwd, repoSelector, prNumber, verifiedHeadSha, base, branch } = options;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { status: "blocked-unknown", reason: "PR 编号无效。" };
  if (!/^[0-9a-f]{40}$/i.test(String(verifiedHeadSha || ""))) return { status: "blocked-unknown", reason: "缺少已确认候选 SHA（本机 HEAD），拒绝合并（不允许无 match-head 合并）。" };
  const key = mergeReceiptKey(repoSelector, prNumber, verifiedHeadSha);
  const before = await viewPrState(gh, cwd, repoSelector, prNumber);
  const selectorParts = repoSelector.split("/"); const selOwner = selectorParts[1] || ""; const selRepo = selectorParts[2] || "";
  // MERGED 快捷路径与写前重查共用同一套完整身份判断：head 仓库/分支/base 严格、owner/repo 与 SHA 不敏感。
  const sameIdentity = (row: PrListRow | undefined) => Boolean(row
    && (row.headRefName || "") === branch && (row.baseRefName || "") === base
    && String(row.headRepositoryOwner || "").toLowerCase() === selOwner.toLowerCase()
    && String(row.headRepository || "").toLowerCase() === `${selOwner}/${selRepo}`.toLowerCase()
    && (row.headRefOid || "").toLowerCase() === verifiedHeadSha.toLowerCase());
  if (before?.row.state === "MERGED" && /^[0-9a-f]{40}$/i.test(before.mergeCommit)) {
    if (!sameIdentity(before.row))
      return { status: "blocked-unknown", state: before.row.state, reason: `该 PR 已 MERGED 但 head 仓库/分支/SHA/base 与本候选不一致——属于另一候选的合并事实，不能当作本候选已合并。` };
    try {
      const unknowns = (await loadUnknownReceipts(ledger)).filter(row => row.key === key);
      for (const prior of unknowns) await (await openReceiptResolved(ledger, prior)).settle("ok", `只读对账：PR 已 MERGED（mergeCommit ${before.mergeCommit.slice(0, 12)}）`);
    } catch { /* 账本不可写时仍如实返回读到的事实 */ }
    return { status: "merged", mergeCommit: before.mergeCommit, state: before.row.state, reason: "只读重查：本候选的 PR 已是 MERGED（可能经网页或先前未知操作完成），未重发合并指令。" };
  }
  if (options.readOnly)
    return { status: "blocked-unknown", state: before?.row.state, reason: before
      ? `只读恢复：该 PR 当前状态（${before.row.state || "未知"}）未构成本候选已 MERGED 的完整确证（身份须逐项等于精确 repo/PR 号/head 仓/分支/SHA/base 且可读 40 位 mergeCommit），不快进祖先、不发送任何合并指令。`
      : "只读恢复：无法只读读取该 PR 当前状态，不快进祖先、不发送任何合并指令。" };
  if (!before) return { status: "blocked-unknown", reason: "无法只读读取该 PR 当前状态，未发送任何写指令。" };
  if (!sameIdentity(before.row))
    return { status: "blocked-unknown", reason: `写前重查 PR 身份不一致（head ${String(before.row.headRefOid).slice(0, 10)}/${before.row.headRefName || "?"} base ${before.row.baseRefName || "?"}），零写入停止。`, state: before.row.state };
  let unknownMerge: Receipt | undefined;
  try { unknownMerge = (await loadUnknownReceipts(ledger)).find(row => row.key === key); }
  catch (error) { return { status: "blocked-unknown", reason: `收据账本不可读（${String((error as Error)?.message || error).slice(0, 160)}），无法保证不重放，未发送合并。` }; }
  if (unknownMerge) return { status: "blocked-unknown", reason: "存在未对账的 merge 收据且当前 view 仍非 MERGED：不重发合并指令；请稍后重试本操作（仅只读对账）或在网页处理后由“合并PR”恢复。", state: before.row.state };
  if (options.revalidate) {
    const gate = await Promise.resolve(options.revalidate()).catch(error => ({ ok: false, reason: `复核执行异常：${String((error as Error)?.message || error).slice(0, 160)}` }));
    if (!gate.ok) return { status: "blocked-verification", reason: `合并写指令前科研确证复核未通过：${gate.reason || "候选摘要不再成立"}。未发送任何写指令。`, state: before.row.state };
  }
  let receipt;
  try { receipt = await openReceipt(ledger, { key, root: cwd, branch: `pr#${prNumber}`, sourceSha: verifiedHeadSha.toLowerCase(), base, repoSelector, action: "merge" }); }
  catch (error) { return { status: "blocked-unknown", reason: `合并前无法落收据（${String((error as Error)?.message || error).slice(0, 160)}），未执行合并。` }; }
  let merged;
  try { merged = await gh(["pr", "merge", String(prNumber), "--repo", repoSelector, "--merge", "--match-head-commit", verifiedHeadSha], cwd); }
  catch (error) {
    await receipt.settle("unknown", `merge 传输异常：${String((error as Error)?.message || error).slice(0, 200)}`);
    return { status: "blocked-unknown", reason: "合并指令结果未知（gh 中断/超时）。必须稍后只读重查 PR 状态，不自动重放。" };
  }
  const after = await viewPrState(gh, cwd, repoSelector, prNumber);
  if (after?.row.state === "MERGED" && /^[0-9a-f]{40}$/i.test(after.mergeCommit)) {
    if (!sameIdentity(after.row)) {
      await receipt.settle("unknown", "MERGED 但身份与本候选不一致（可能是他人改动），按未知停止");
      return { status: "blocked-unknown", reason: "PR 显示 MERGED 但完整身份与本候选不一致，不按本候选已合并处理。", state: after.row.state };
    }
    await receipt.settle("ok", `MERGED mergeCommit=${after.mergeCommit.slice(0, 12)}`);
    return { status: "merged", mergeCommit: after.mergeCommit, state: after.row.state };
  }
  const kind = merged.code === 0 ? "unknown" : classifyWriteFailure(merged.stderr);
  await receipt.settle(after?.row.state ? "unknown" : kind, `exit=${merged.code} state=${after?.row.state || "?"} ${(merged.stderr || "").slice(0, 160)}`);
  return after?.row.state === "MERGED"
    ? { status: "blocked-unknown", reason: "PR 显示 MERGED 但读不到 mergeCommit，祖先更新暂缓。", state: after.row.state }
    : after?.row.state && after.row.state !== "MERGED" && merged.code === 0
      ? { status: "not-merged", reason: `合并未生效（PR 状态 ${after.row.state}）：${(merged.stderr || "").slice(0, 200)}`, state: after.row.state }
      : { status: "blocked-unknown", reason: `合并结果未知（exit ${merged.code}，重查状态${after?.row.state ? " " + after.row.state : "失败"}），不重放。`, state: after?.row.state };
}

export type FastForwardResult = { status: "fast-forwarded" | "already-current" | "blocked" | "failed"; from?: string; to?: string; reason?: string };

/**
 * 收据 key＝远端操作语义身份：GitHub 仓库（大小写不敏感规范化）＋动作＋分支（大小写敏感引用原值）＋SHA（不敏感）＋base 原值。
 * 刻意不含 cwd——同一远端操作换个工作目录拼写不能绕过未对账拒绝；root 仍作展示字段保留在行里。
 * push/pr-create/merge 各自动作互不覆盖。
 */
export function receiptKey(targetKey: string[], action: Receipt["action"], repoSelector: string): string {
  const [, branch, sourceSha, base] = targetKey;
  return JSON.stringify([String(repoSelector).toLowerCase(), action, String(branch), String(sourceSha).toLowerCase(), String(base)]);
}
export function mergeReceiptKey(repoSelector: string, prNumber: number, verifiedHeadSha: string): string {
  return JSON.stringify([String(repoSelector).toLowerCase(), "merge", prNumber, String(verifiedHeadSha).toLowerCase()]);
}

/**
 * 祖先 ff（R4）：readIdentity 由宿主注入（每次真实探针）；真实 root/common-dir/origin repo 核对，fetch 前后各核一次
 * 干净 HEAD/分支；ff 用已核完整目标 SHA；要求 目标包含已确认合并提交 ∧ 本机 HEAD 是目标祖先（merge 之后的后续头
 * 也可安全 ff）；绝不 reset/stash/切分支。
 */
export async function fastForwardAncestorRoot(options: {
  git: PullRequestRunner; cwd: string; remoteName: string; base: string; expectedMergeCommit: string;
  expectedRemoteUrl: string; readIdentity: () => { branch: string; headCommit: string; dirty: boolean; error?: string };
}): Promise<FastForwardResult> {
  const { git, cwd, remoteName, base, expectedMergeCommit, expectedRemoteUrl, readIdentity } = options;
  // 真实 origin 必须仍是已确认的祖先 origin：原始串一致，或两者都能规范化且指向同一 GitHub 仓库。
  const rejectRepoDrift = (url: string) => {
    const liveRaw = String(url || "").trim(); const expectedRaw = String(expectedRemoteUrl || "").trim();
    if (liveRaw && liveRaw === expectedRaw) return "";
    const live = normalizeGithubTarget(liveRaw); const expected = normalizeGithubTarget(expectedRaw);
    if (sameRepo(live, expected)) return "";
    // UI/收据错误只展示剥凭据后的规范化目标或类别，绝不回显 raw URL（其中可能带确认后新出现的凭证）。
    const show = (target: ReturnType<typeof normalizeGithubTarget>, raw: string) => target ? target.displayUrl : (raw ? "无法规范化的地址（凭据已剥离，不显示原文）" : "空");
    return `真实 origin（${show(live, liveRaw)}）与已确认祖先 origin（${show(expected, expectedRaw)}）不一致，停止（未 fetch、未改动）。`;
  };
  const check = (): FastForwardResult | undefined => {
    const identity = readIdentity();
    if (identity.error) return { status: "blocked", reason: `Git 身份读取失败：${identity.error}` };
    if (identity.dirty) return { status: "blocked", reason: "祖先工作区不干净，跳过快进（不 stash、不覆盖任何文件）。" };
    if (identity.branch !== base) return { status: "blocked", reason: `祖先当前分支是 ${identity.branch || "(detached)"}，不是目标分支 ${base}，跳过快进。` };
    return undefined;
  };
  const first = check(); if (first) return first;
  const paths = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], cwd);
  if (paths.code !== 0) return { status: "blocked", reason: "无法读取仓库根/common-dir，停止。" };
  const [toplevelRaw, commonRaw] = paths.stdout.toString("utf8").split(/\r?\n/);
  const norm = (value: string) => String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
  if (!toplevelRaw || norm(toplevelRaw) !== norm(cwd)) return { status: "blocked", reason: `当前目录（${String(cwd).slice(0, 120)}）不是已确认根 ${String(toplevelRaw || "").slice(0, 120)}，停止。` };
  if (!commonRaw) return { status: "blocked", reason: "无法解析 common-dir，停止。" };
  const liveUrl = await git(["remote", "get-url", remoteName], cwd);
  if (liveUrl.code !== 0) return { status: "blocked", reason: `本地不存在远端 ${remoteName}，停止。` };
  const drift = rejectRepoDrift(liveUrl.stdout.toString("utf8"));
  if (drift) return { status: "blocked", reason: drift };
  const beforeHead = readIdentity().headCommit.toLowerCase();
  const fetched = await git(["fetch", remoteName, `+refs/heads/${base}:refs/remotes/${remoteName}/${base}`], cwd);
  if (fetched.code !== 0) return { status: "failed", reason: `fetch ${remoteName}/${base} 失败：${(fetched.stderr || "").slice(0, 200) || `exit ${fetched.code}`}` };
  const afterFetch = check(); if (afterFetch) return afterFetch; // fetch 期间身份/干净状态变化 → 停
  const nowHead = readIdentity().headCommit.toLowerCase();
  if (nowHead !== beforeHead) return { status: "blocked", reason: `fetch 期间本机 HEAD 从 ${beforeHead.slice(0, 10)} 变为 ${nowHead.slice(0, 10)}，身份变化，停止。` };
  const remoteHead = await git(["rev-parse", `refs/remotes/${remoteName}/${base}`], cwd);
  const to = remoteHead.code === 0 ? remoteHead.stdout.toString("utf8").trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(to)) return { status: "failed", reason: "读取远端目标分支头失败，未改动本机。" };
  const merge = expectedMergeCommit.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(merge)) return { status: "blocked", reason: "缺少完整的已确认合并提交 SHA，暂缓快进。" };
  const contains = await git(["merge-base", "--is-ancestor", merge, to], cwd);
  if (contains.code !== 0) return { status: "blocked", reason: `远端 ${base} 当前头（${to.slice(0, 10)}）尚未包含已确认合并提交（${merge.slice(0, 10)}），暂缓快进。` };
  if (to === beforeHead) return { status: "already-current", from: beforeHead, to };
  const ancestor = await git(["merge-base", "--is-ancestor", beforeHead, to], cwd);
  if (ancestor.code !== 0) return { status: "blocked", reason: `本机 ${beforeHead.slice(0, 10)} 不是远端 ${to.slice(0, 10)} 的祖先（已分叉），跳过快进，绝不合并提交/reset。` };
  // R5c：真正 merge 前的最后复核——身份/干净/分支、HEAD 仍是初始确认值、origin 仍匹配、跟踪头未再移动。
  const preMerge = check(); if (preMerge) return preMerge;
  const preHead = readIdentity().headCommit.toLowerCase();
  if (preHead !== beforeHead) return { status: "blocked", reason: `merge 前本机 HEAD 已从 ${beforeHead.slice(0, 10)} 变为 ${preHead.slice(0, 10)}，按初始确认停止，不追新。` };
  const liveUrl2 = await git(["remote", "get-url", remoteName], cwd);
  const drift2 = liveUrl2.code !== 0 ? "本地远端在复核期间消失" : rejectRepoDrift(liveUrl2.stdout.toString("utf8"));
  if (drift2) return { status: "blocked", reason: drift2.replace("，停止（未 fetch、未改动）。", "，merge 前停止（本机未改动）。") };
  const remoteHeadNow = await git(["rev-parse", `refs/remotes/${remoteName}/${base}`], cwd);
  const toNow = remoteHeadNow.code === 0 ? remoteHeadNow.stdout.toString("utf8").trim().toLowerCase() : "";
  if (toNow !== to) return { status: "blocked", reason: "merge 前远端跟踪头已再次变化，停止；请重新预览确认后再快进。" };
  const ff = await git(["merge", "--ff-only", to], cwd); // 已核完整 SHA，不用可漂移符号 ref
  if (ff.code !== 0) return { status: "blocked", reason: `ff-only 未生效：${(ff.stderr || ff.stdout.toString("utf8") || "").slice(0, 240)}。未做任何合并提交/reset。` };
  return { status: "fast-forwarded", from: beforeHead, to };
}
