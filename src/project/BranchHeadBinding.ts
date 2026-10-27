/**
 * src/project/BranchHeadBinding.ts - 块C3：把 PLAN 的已验 executionSource 精确绑定到仓库当前提交树。
 *
 * 契约（主控 2026-10-25 精确化）：当前 HEAD 要能代表“已验源码”，仅靠 Git clean 与工作树同内容
 * 不够——被 .gitignore 的代码依赖可能只存在于磁盘而不在 HEAD 里。判定渠道＝对同一根目录，
 * 当前提交树必须包含 manifest 全部路径、类型/大小/内容 SHA 与已验清单一致；比较读 git blob
 * 原始字节（cat-file --batch）而非 UTF8 字符串重编码；任何输出只含路径/大小/哈希，绝不打印
 * blob 内容或密钥。忽略/未跟踪依赖不在提交中＝如实“无法证明此 HEAD”，不 stage、不 commit、
 * 不新增数据/权重哈希系统。dirty→clean 仅元数据变化而 blob 一致时结论可复用，不重跑科研。
 *
 * 本模块纯 Node：git 执行器注入（测试用假执行器或真实临时仓），无 vscode/IO 之外的隐式依赖。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { sanitizeGitEnv } from "./GitIdentityProbe";
import { planExecutionSourceDigest, planManifestPathSafe } from "../extension/PlanCodeScopeHost";
import { completionIdentity, hasVerifiedCompletion } from "../features/VerifiedCompletion";

export type HeadBindingRunner = (args: string[], cwd: string, stdin?: string) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

const GIT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const CAT_FILE_CHUNK = 300;
const MANIFEST_MAX_FILES = 4096;

/** 真实执行器：clean-env spawn（继承的 GIT_DIR 等一律剪除，同 GitIdentityProbe 口径），无 shell，
 * 输出为原始 Buffer（blob 字节比较不许经过字符串编码），超上限/超时即失败关闭。 */
export const runGitBinary: HeadBindingRunner = (args, cwd, stdin) => {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: sanitizeGitEnv(process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0; let overflow = false; let stderr = "";
    const timer = setTimeout(() => { overflow = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > GIT_MAX_OUTPUT_BYTES) { overflow = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (overflow) reject(new Error("git 输出超过上限或超时，按未知处理（未读取任何内容）。"));
      else resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 600) });
    });
    child.stdin.on("error", () => undefined);
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
};

/** `git ls-tree -r -z --full-tree <commit>`：NUL 分隔记录 `<mode> <type> <oid>\t<path>`（-z 免引号/编码歧义）。 */
export function parseLsTreeZ(output: string): Map<string, { mode: string; oid: string }> {
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const meta = tab < 0 ? record : record.slice(0, tab);
    const relative = tab < 0 ? "" : record.slice(tab + 1);
    const parts = meta.split(" ");
    if (parts.length !== 3 || !relative || !/^\d{6}$/.test(parts[0])) continue;
    entries.set(relative, { mode: parts[0], oid: parts[2] });
  }
  return entries;
}

type BatchFrame = { status: "ok" | "missing" | "type" | "error"; type?: string; content?: Buffer };

/** `git cat-file --batch`：头 `<oid> <type> <size>\n<字节>\n` 或 `<oid> missing\n`；只回传字节用于哈希。 */
function parseCatFileBatch(frames: number, stdout: Buffer): BatchFrame[] {
  const rows: BatchFrame[] = [];
  let pos = 0;
  for (let index = 0; index < frames; index++) {
    const end = stdout.indexOf(0x0a, pos);
    if (end < 0) { rows.push({ status: "error" }); for (let rest = rows.length; rest < frames; rest++) rows.push({ status: "error" }); return rows; }
    const header = stdout.subarray(pos, end).toString("utf8").split(" ");
    pos = end + 1;
    if (header.length === 2 && header[1] === "missing") { rows.push({ status: "missing" }); continue; }
    if (header.length !== 3 || !Number.isInteger(Number(header[2]))) { rows.push({ status: "error" }); for (let rest = rows.length; rest < frames; rest++) rows.push({ status: "error" }); return rows; }
    const size = Number(header[2]);
    if (pos + size + 1 > stdout.length || stdout[pos + size] !== 0x0a) { rows.push({ status: "error" }); for (let rest = rows.length; rest < frames; rest++) rows.push({ status: "error" }); return rows; }
    const content = stdout.subarray(pos, pos + size);
    pos += size + 1;
    rows.push(header[1] === "blob" ? { status: "ok", content } : { status: "type", type: header[1] });
  }
  return rows;
}

export type ManifestBindingResult = {
  ok: boolean;
  coveredFiles: number;
  coveredBytes: number;
  failures: Array<{ path: string; reason: string }>;
  note: string;
};

/** 当前提交树 vs 已验 manifest：路径/类型/size/内容 SHA（blob 原始字节 sha256）。失败只带路径与类别。 */
export async function verifyCommitTreeAgainstManifest(options: {
  runner: HeadBindingRunner; cwd: string; commit: string; manifest: Record<string, { size: number; sha256: string }>;
}): Promise<ManifestBindingResult> {
  const { runner, cwd, manifest } = options;
  // 精确提交合同（主控 2026-10-25，宿主 274 轮实证）：Git 对“有效 40SHA+后缀”这类宽容输入可能
  // exit0 解析回原提交，宽容接受≠已确认身份。绑定前自己要求完整 40 位十六进制，并在既有的一次
  // rev-parse 上做解析往返核对（^{commit} 解引用不存在对象即失败；返回值必须逐值等于规范化输入）。
  const commit = String(options.commit || "").trim().toLowerCase();
  const keys = Object.keys(manifest || {});
  const failures: Array<{ path: string; reason: string }> = [];
  if (!/^[0-9a-f]{40}$/.test(commit))
    return { ok: false, coveredFiles: 0, coveredBytes: 0, failures: [{ path: "(commit)", reason: "不是完整 40 位十六进制提交 SHA：Git 的宽容前缀/后缀解析不能当作已确认身份，拒绝解析与读取（未发起任何 Git 调用）" }], note: "" };
  if (!keys.length || keys.length > MANIFEST_MAX_FILES)
    return { ok: false, coveredFiles: 0, coveredBytes: 0, failures: [{ path: "(manifest)", reason: keys.length ? `清单文件数 ${keys.length} 超出 ${MANIFEST_MAX_FILES} 上限` : "已验清单为空" }], note: "" };
  for (const relative of keys) if (!planManifestPathSafe(relative)) failures.push({ path: relative.slice(0, 200), reason: "路径不符合已验清单的相对路径规则" });
  if (failures.length) return { ok: false, coveredFiles: 0, coveredBytes: 0, failures, note: "" };
  const verify = await runner(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], cwd);
  if (verify.code !== 0) return { ok: false, coveredFiles: 0, coveredBytes: 0, failures: [{ path: "(commit)", reason: "该提交在此仓库中不存在或不可读（^{commit} 解引用失败）" }], note: "" };
  const resolved = verify.stdout.toString("utf8").trim().toLowerCase();
  if (resolved !== commit)
    return { ok: false, coveredFiles: 0, coveredBytes: 0, failures: [{ path: "(commit)", reason: `rev-parse 解析结果（${resolved ? resolved.slice(0, 12) + "…" : "空"}）不等于已确认的完整提交 SHA，不按该身份绑定（未读取任何树）` }], note: "" };
  const listing = await runner(["ls-tree", "-r", "-z", "--full-tree", commit], cwd);
  if (listing.code !== 0)
    return { ok: false, coveredFiles: 0, coveredBytes: 0, failures: [{ path: "(commit)", reason: `提交树读取失败：${(listing.stderr || "").slice(0, 200) || `exit ${listing.code}`}` }], note: "" };
  const tree = parseLsTreeZ(listing.stdout.toString("utf8"));
  const hashable: Array<{ path: string; oid: string; expected: { size: number; sha256: string } }> = [];
  for (const relative of keys) {
    const entry = tree.get(relative);
    if (!entry) { failures.push({ path: relative, reason: "不在当前提交树中（Git 忽略/未跟踪的磁盘依赖不能算已提交内容）" }); continue; }
    if (entry.mode === "120000") { failures.push({ path: relative, reason: "提交树中是符号链接，与工作树普通文件不同构" }); continue; }
    if (entry.mode !== "100644" && entry.mode !== "100755") { failures.push({ path: relative, reason: `提交树中类型 mode ${entry.mode} 不是普通文件` }); continue; }
    hashable.push({ path: relative, oid: entry.oid, expected: manifest[relative] });
  }
  let coveredFiles = 0; let coveredBytes = 0;
  for (let start = 0; start < hashable.length; start += CAT_FILE_CHUNK) {
    const chunk = hashable.slice(start, start + CAT_FILE_CHUNK);
    const batch = await runner(["cat-file", "--batch"], cwd, chunk.map(row => `${row.oid}\n`).join(""));
    if (batch.code !== 0 && !batch.stdout.length) {
      for (const row of chunk) failures.push({ path: row.path, reason: `blob 批量读取失败：${(batch.stderr || "").slice(0, 160) || `exit ${batch.code}`}` });
      continue;
    }
    const frames = parseCatFileBatch(chunk.length, batch.stdout);
    for (let index = 0; index < chunk.length; index++) {
      const row = chunk[index]; const frame = frames[index];
      if (!frame || frame.status === "missing") { failures.push({ path: row.path, reason: "提交树记录的 blob 在对象库中缺失" }); continue; }
      if (frame.status === "type") { failures.push({ path: row.path, reason: `对象类型 ${frame.type} 不是 blob` }); continue; }
      if (frame.status !== "ok" || !frame.content) { failures.push({ path: row.path, reason: "blob 帧解析失败，按未知处理" }); continue; }
      if (frame.content.length !== row.expected.size) { failures.push({ path: row.path, reason: `大小不一致（已验 ${row.expected.size}，提交内 ${frame.content.length}）` }); continue; }
      if (createHash("sha256").update(frame.content).digest("hex") !== row.expected.sha256) { failures.push({ path: row.path, reason: "内容 SHA 与已验清单不一致" }); continue; }
      coveredFiles++; coveredBytes += frame.content.length;
    }
  }
  return {
    ok: failures.length === 0 && coveredFiles === keys.length,
    coveredFiles, coveredBytes, failures,
    note: "覆盖范围仅为本 PLAN 已验清单内的源码与配置；数据、权重与仓外输入不在清单内，不构成整仓或科研结论等价。",
  };
}

export type PlanHeadBinding = ManifestBindingResult & { reason?: string; headCommit: string };

/** 绑定单个 PLAN 的已验 executionSource 到当前 HEAD：digest 自校验、PLAN 文件 revision 锚定，再逐文件核提交树。 */
export async function bindPlanSourceToCommit(options: {
  runner: HeadBindingRunner; cwd: string; headCommit: string;
  executionSource?: { digest: string; manifest: Record<string, { size: number; sha256: string }> };
  planFile: string; revision: string;
}): Promise<PlanHeadBinding> {
  const { runner, cwd, headCommit, executionSource, planFile, revision } = options;
  const empty = { coveredFiles: 0, coveredBytes: 0, failures: [] as Array<{ path: string; reason: string }>, note: "", headCommit };
  const source = executionSource;
  if (!source?.manifest || typeof source.manifest !== "object" || !Object.keys(source.manifest).length)
    return { ...empty, ok: false, reason: "该 PLAN 没有已验 executionSource 清单，无法证明此 HEAD 来自已验源码。" };
  if (Object.keys(source.manifest).length > MANIFEST_MAX_FILES)
    return { ...empty, ok: false, reason: `已验清单 ${Object.keys(source.manifest).length} 个文件超出 ${MANIFEST_MAX_FILES} 上限，按未知处理。` };
  if (source.digest !== planExecutionSourceDigest(source.manifest))
    return { ...empty, ok: false, reason: "清单摘要自校验失败（PLAN_SOURCE_BASELINE_INVALID 同口径），拒绝绑定。" };
  if (source.manifest[planFile]?.sha256 !== revision)
    return { ...empty, ok: false, reason: "清单内 PLAN 文件哈希与 plan.revision 不一致，提交身份不可信。" };
  const result = await verifyCommitTreeAgainstManifest({ runner, cwd, commit: headCommit, manifest: source.manifest });
  return { ...result, headCommit, reason: result.ok ? "" : "无法证明此 HEAD：存在与已验清单不一致或缺失的路径（见逐项原因；系统不会代为 stage/commit）。" };
}

/* ————————————— 块C4-R3：科研候选构建/复核（最窄方案，无 schema/Worker 协议变化） —————————————
 * 不可变契约锚点（DPQ enqueuePlan:1003-1013）：同 plan.id 下 planFile/revision/codeFingerprint/
 * executionMode/jobs 声明任何不同都属 FORMAL_JOB_IDENTITY_CONFLICT，重跑会换 commandId/worker 使
 * 完成确证按既有 identity 契约自动失效；恢复不改版本字段。故本模块只从队列原始值（不是截 24 位、
 * 无 codeFingerprint 的对比投影）读取完整身份，逐 job 只认 hasVerifiedCompletion（TrustedTerminalProof
 * 仅证终止/配额释放，不是科研完成；不判优、不加 TTL、不自动打分），并用既有 bindPlanSourceToCommit
 * 证明同一已确认 HEAD 的提交树逐 blob 等于冻结清单。dirty 运行留下的确证不因 provenance
 * localCommit≠HEAD 被一票否决——同字节再提交后 blob 绑定依旧成立，这正是可复用性的来源。
 * digest 只绑定不可变事实（root/common-dir/分支/完整 40 位 SHA/完整版本元组/每 job completionIdentity/
 * manifest digest/当前 dirty），绝不掺轮询时间戳；确认后任何撤证、命令变化、版本变化、manifest
 * 缺失都会令重算 digest 不同或校验失败 → 调用方必须零后续写入。 */
export type CandidatePlanEntry = {
  planId: string; projectId: string; planFile: string; revision: string; codeFingerprint: string; executionMode: string;
  manifestDigest: string; jobCount: number; jobIdentities: string[];
};
export type ResearchCandidate = {
  ok: boolean; reason?: string;
  root?: string; commonDir?: string; branch?: string; headCommit?: string; dirty?: boolean;
  plans?: CandidatePlanEntry[]; digest?: string;
};
export type ResearchCandidateInput = {
  runner: HeadBindingRunner; root: string; commonDir: string; branch: string; headCommit: string; dirty: boolean;
  queueState: "ok" | "missing" | "corrupt"; queueError?: string;
  plans: Array<any> | undefined; selectedPlanIds: string[];
};

/** 构建（或复核）科研候选：任何一步不满足都如实 ok:false＋可执行原因；绝不部分通过。 */
export async function buildResearchCandidate(input: ResearchCandidateInput): Promise<ResearchCandidate> {
  const fail = (reason: string): ResearchCandidate => ({ ok: false, reason });
  if (input.queueState !== "ok" || !Array.isArray(input.plans))
    return fail(`该分支项目队列${input.queueState === "corrupt" ? "不可读/已损坏（" + String(input.queueError || "").slice(0, 160) + "）" : "缺失"}：没有任何可核实的科研记录，拒绝把未知当确证。`);
  const selected = [...new Set(input.selectedPlanIds.map(String))];
  if (!selected.length) return fail("必须至少选择一个 PLAN 作为推送候选；不自动判优、不默认全选。");
  if (!/^[0-9a-f]{40}$/i.test(String(input.headCommit || "")) || !input.branch)
    return fail("分支/完整 HEAD SHA 身份不可用，无法绑定候选。");
  const entries: CandidatePlanEntry[] = [];
  for (const planId of selected) {
    const plan = input.plans.find(row => String(row?.id) === planId);
    if (!plan) return fail(`队列中已找不到 PLAN ${planId}（撤证/清理/队列变化）：候选失效，零写入停止。`);
    const missing = ["projectId", "id", "planFile", "revision", "codeFingerprint"].filter(field => !String(plan[field] || "").trim());
    if (missing.length) return fail(`PLAN ${plan.planFile || planId} 缺少完整不可变身份字段（${missing.join("/")}），不能作为候选。`);
    if (!Array.isArray(plan.jobs) || !plan.jobs.length) return fail(`PLAN ${plan.planFile} 没有任何 job，无完成确证可言。`);
    const jobIdentities: string[] = [];
    for (const job of plan.jobs) {
      if (!hasVerifiedCompletion(plan, job))
        return fail(`PLAN ${plan.planFile} 第 ${String(job?.index)} 个 job 没有完成确证（verifiedCompletion：exit0＋身份全等）；TrustedTerminalProof/状态文字/已终止都不算科研完成，拒绝。`);
      jobIdentities.push(completionIdentity(plan, job));
    }
    const source = plan.executionSource;
    if (!source?.manifest || !Object.keys(source.manifest).length)
      return fail(`PLAN ${plan.planFile} 缺少已验 executionSource 清单：无法证明 HEAD 来自已验源码（manifest 缺失即候选不成立）。`);
    const binding = await bindPlanSourceToCommit({ runner: input.runner, cwd: input.root, headCommit: input.headCommit, executionSource: source, planFile: plan.planFile, revision: plan.revision });
    if (!binding.ok)
      return fail(`PLAN ${plan.planFile}：当前 HEAD 无法逐 blob 等于冻结清单——${binding.reason}首个差异：${binding.failures[0] ? binding.failures[0].path + "（" + binding.failures[0].reason + "）" : "无"}`);
    entries.push({ planId: String(plan.id), projectId: String(plan.projectId), planFile: String(plan.planFile), revision: String(plan.revision),
      codeFingerprint: String(plan.codeFingerprint), executionMode: String(plan.executionMode || ""), manifestDigest: String(source.digest),
      jobCount: plan.jobs.length, jobIdentities: jobIdentities.sort() });
  }
  entries.sort((a, b) => a.planId.localeCompare(b.planId));
  const digest = createHash("sha256").update(JSON.stringify({ root: input.root, commonDir: input.commonDir, branch: input.branch,
    headCommit: input.headCommit.toLowerCase(), dirty: input.dirty === true, plans: entries })).digest("hex");
  return { ok: true, root: input.root, commonDir: input.commonDir, branch: input.branch, headCommit: input.headCommit,
    dirty: input.dirty === true, plans: entries, digest };
}
