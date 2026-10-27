import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { isStaleRetentionRow, retentionOwnership, RetentionIndex } from "../features/PluginLogRetention";

type Candidate = { path: string; fullPath: string; type: "file"; bytes: number; modifiedAt: number; purpose: string; token: string; workerId: string; retentionStale?: boolean; previewOnly?: boolean };
type Endpoint = { id: string; role: string };
type WorkerScan = { id: string; count: number; bytes: number; status: "loading" | "ready" | "unavailable"; error?: string };
type BlockedRow = { path: string; reason: string; workers: string[]; planFile: string };
type CleanupContext = { client: any; endpoints: Endpoint[]; localRoot?: string; generation: number; reviewPlanOutputs?: () => Promise<void>; retentionIndex?: () => Promise<RetentionIndex>; retentionHolds?: () => Promise<string[]>; retentionBlocked?: () => Promise<BlockedRow[]>; withRetentionLease?: (work: (lease: any) => Promise<void>) => Promise<void> };

// A blocked admission names the exact leaving generations that hold an incoming run out of the
// two-generation window; the review must surface them as confirmed-cleanup candidates, otherwise
// a user waiting on a third generation has no path forward at all.
function blockedPurpose(row: BlockedRow): string {
  return `第三代提交正被该退出代阻挡：按虚拟“当前＋上一次”窗口，经确认清理退场后即可落盘（原因 ${row.reason}，来源 ${row.planFile || "队列"}）`;
}
// Unknown claims state is fail-closed: without a fresh holds list, managed stale rows cannot be
// assumed unheld.
function retentionRowHeld(row: Candidate, retention: RetentionIndex | undefined, holds: Set<string> | undefined): boolean {
  if (holds === undefined) return true;
  if (!retention) return true;
  const stale = isStaleRetentionRow(retention, row.path);
  if (!stale) return false;
  return holds.has(`${stale.planFile}|${stale.taskKey}`);
}
function applyRetention(rows: Candidate[], retention: RetentionIndex | undefined, holds: Set<string> | undefined, blocked: Map<string, BlockedRow>): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rows) {
    const blockedRow = blocked.get(row.path);
    if (blockedRow && holds !== undefined && blockedRow.workers.includes(row.workerId)
      && ![...holds].some(key => blockedRow.planFile && key.startsWith(blockedRow.planFile + "|"))) {
      out.push({ ...row, retentionStale: true, previewOnly: undefined, purpose: blockedPurpose(blockedRow) }); continue;
    }
    const ownership = retention ? retentionOwnership(retention, row.path) : "unknown-manifest";
    if (ownership === "protected") continue;
    if (ownership === "stale") {
      if (retentionRowHeld(row, retention, holds)) out.push({ ...row, previewOnly: true, purpose: "在途提交的两代保留声明正持有该代际（仅预览，确认清理不可选中）" });
      else out.push(row);
      continue;
    }
    if (ownership === "unowned" || ownership === "unknown-manifest") { out.push({ ...row, previewOnly: true, purpose: "受管前缀内但归属清单无法指认其代际（仅预览，不会删除）" }); continue; }
    if (row.path.startsWith("simple_cluster/tmp/backups/") && row.path.endsWith(".bak")) out.push(row);
    else out.push({ ...row, previewOnly: true, purpose: "未声明代际的旧缓存（仅预览，请通过精确路径清理入口审核）" });
  }
  return out;
}

const html = (nonce: string) => `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px;line-height:1.5}h1{font-size:20px}p{color:var(--vscode-descriptionForeground)}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;cursor:pointer;margin-right:8px}button:disabled{opacity:.5;cursor:default}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.summary{padding:12px;background:var(--vscode-editorWidget-background);margin:12px 0}.group{border:1px solid var(--vscode-panel-border);margin:10px 0}.group>summary{padding:9px;cursor:pointer;font-weight:bold}.rows{padding:4px 12px 12px}.row{display:flex;gap:9px;align-items:flex-start;padding:6px;border-top:1px solid var(--vscode-panel-border)}.row span{min-width:0;overflow-wrap:anywhere}.meta{color:var(--vscode-descriptionForeground)}.path{font-family:var(--vscode-editor-font-family);font-size:12px}.warning{color:var(--vscode-errorForeground)}#review{border:2px solid var(--vscode-errorForeground);padding:12px;margin-top:15px}#reviewPaths{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-editor-background);padding:10px}#status{margin:12px 0;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><h1>缓存回收审核</h1><p>下方按“当前运行＋上一次运行”审核受管日志；归属不明的旧文件仅供预览。Worker 有活动任务时不列候选；结果、权重、TensorBoard、原始测试结果表和机器状态保留。Plan 历史产物通过单独入口按代码版本审核。按本机或服务器的目录分组审核，勾选目录会选中其中展示的文件。</p><button id="planOutputs" class="secondary">Plan 历史产物审核</button><button id="refresh" class="secondary">刷新候选</button><button id="selectAll" class="secondary">全选候选</button><button id="deselectAll" class="secondary">清空选择</button><div id="summary" class="summary">正在读取…</div><div id="tree"></div><button id="reviewButton" disabled>审核所选路径</button><div id="review" hidden><h2>确认完整路径</h2><p id="reviewHint"></p><div id="reviewPaths"></div><button id="confirmButton">确认这些完整路径</button><button id="cancelButton" class="secondary">返回</button></div><div id="status" role="status"></div><script nonce="${nonce}">
const vscode=acquireVsCodeApi();let rows=[],stage=0,reviewKeys=[],scanning=false;const tree=document.getElementById('tree'),summary=document.getElementById('summary'),status=document.getElementById('status'),review=document.getElementById('review');
document.getElementById('planOutputs').onclick=()=>vscode.postMessage({type:'planOutputs'});
function selected(){return Array.from(document.querySelectorAll('input[data-key]:checked')).map(x=>x.dataset.key)}
function updateButton(){document.getElementById('reviewButton').disabled=scanning||!selected().length;document.getElementById('refresh').disabled=scanning;document.getElementById('selectAll').disabled=scanning;document.getElementById('deselectAll').disabled=scanning}
function render(scans){tree.replaceChildren();const groups=new Map();for(const row of rows){const folder=row.path.slice(0,row.path.lastIndexOf('/'))||'.',key=row.workerId+'|'+folder;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}for(const [key,items] of groups){const d=document.createElement('details');d.className='group';const s=document.createElement('summary');const box=document.createElement('input');box.type='checkbox';box.title='勾选此目录内列出的候选文件';box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('change',()=>{for(const c of d.querySelectorAll('input[data-key]'))if(!c.disabled)c.checked=box.checked;updateButton()});s.append(box,' '+items[0].workerId+' · '+items[0].path.slice(0,items[0].path.lastIndexOf('/'))+' · '+items.length+' 个候选 · '+items[0].purpose);d.append(s);const list=document.createElement('div');list.className='rows';for(const row of items){const wrap=document.createElement('label');wrap.className='row';const check=document.createElement('input');check.type='checkbox';if(row.previewOnly)check.disabled=true;else check.dataset.key=row.workerId+'|'+row.path;check.addEventListener('change',()=>{box.checked=Array.from(d.querySelectorAll('input[data-key]')).filter(x=>!x.disabled).every(x=>x.checked);updateButton()});const content=document.createElement('span');const name=document.createElement('div');name.className='path';name.textContent=row.fullPath;const meta=document.createElement('div');meta.className='meta';meta.textContent=(row.bytes/1048576).toFixed(2)+' MB · '+new Date(row.modifiedAt*1000).toLocaleString('zh-CN',{hour12:false})+' · '+row.purpose;content.append(name,meta);wrap.append(check,content);list.append(wrap)}d.append(list);tree.append(d)}summary.textContent=rows.length+' 个候选 · '+(rows.reduce((n,r)=>n+r.bytes,0)/1048576).toFixed(2)+' MB'+String.fromCharCode(10)+(scans||[]).map(s=>s.id+'：'+(s.status==='loading'?'正在读取…':s.error?'未完成 · '+s.error:s.count+' 个可回收 · '+(s.bytes/1048576).toFixed(2)+' MB')).join(String.fromCharCode(10));summary.style.whiteSpace='pre-wrap';updateButton()}
function showReview(){review.hidden=false;document.getElementById('reviewPaths').textContent=reviewKeys.map(k=>{const r=rows.find(x=>x.workerId+'|'+x.path===k);return r?r.workerId+'  '+r.fullPath:''}).join(String.fromCharCode(10));document.getElementById('reviewHint').textContent=stage===0?'第一次确认：核对每个服务器和完整路径。':'第二次确认：再次核对同一批完整路径，确认后永久删除。';document.getElementById('confirmButton').textContent=stage===0?'第一次确认完整路径':'第二次确认并永久删除';review.scrollIntoView({block:'nearest'})}
document.getElementById('refresh').onclick=()=>{review.hidden=true;stage=0;status.textContent='正在刷新候选…';vscode.postMessage({type:'refresh'})};document.getElementById('selectAll').onclick=()=>{document.querySelectorAll('input[data-key]').forEach(x=>{if(!x.disabled)x.checked=true});document.querySelectorAll('.group>summary input').forEach(x=>x.checked=true);updateButton()};document.getElementById('deselectAll').onclick=()=>{document.querySelectorAll('input').forEach(x=>x.checked=false);updateButton()};document.getElementById('reviewButton').onclick=()=>{reviewKeys=selected();stage=0;vscode.postMessage({type:'review',keys:reviewKeys});showReview()};document.getElementById('cancelButton').onclick=()=>{review.hidden=true;stage=0;vscode.postMessage({type:'cancelReview'})};document.getElementById('confirmButton').onclick=()=>{if(stage===0){stage=1;vscode.postMessage({type:'confirmFirst',keys:reviewKeys});showReview();return}review.hidden=true;status.textContent='正在逐台删除所选候选…';vscode.postMessage({type:'confirmSecond',keys:reviewKeys})};window.addEventListener('message',event=>{const m=event.data;if(m.type==='data'){scanning=m.busy===true;review.hidden=true;stage=0;reviewKeys=[];rows=m.rows||[];render(m.scans);status.textContent=m.note||''}if(m.type==='error'){if(m.busy===false)scanning=false;status.textContent=m.message||'操作失败';updateButton()}if(m.type==='busy'){scanning=true;review.hidden=true;status.textContent=m.message||'正在处理…';updateButton()}});vscode.postMessage({type:'refresh'});
</script></body></html>`;

const candidateExtensions = new Set([".log", ".tmp", ".bak", ".part", ".zip"]);
const protectedMarkers = ["tensorboard", "tb_log", "checkpoint", "weight", "model_cache", "dataset"];
const MAX_SCAN_DIRECTORIES = 10_000;
const MAX_SCAN_ENTRIES = 100_000;
const MAX_CLEANUP_CANDIDATES = 20_000;
const protectedName = (name: string) => protectedMarkers.some(marker => name.toLowerCase().includes(marker));

function candidateIdentity(relative: string, stat: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeNs: bigint; nlink: number | bigint }): string {
  return crypto.createHash("sha256").update(`${relative}|${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.nlink}`).digest("hex");
}

function schedulerStateCleanupOwnerMatches(root: string, fullPath: string, state: any): boolean {
  try {
    const owner = state?.cleanupOwner;
    if (owner?.schemaVersion !== 1 || owner.purpose !== "scheduler-state") return false;
    const comparablePath = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
    const normalizedRoot = comparablePath(root);
    if (comparablePath(realPathSync(String(owner.projectRoot || ""))) !== normalizedRoot) return false;
    const normalizedFile = comparablePath(fullPath);
    if (comparablePath(realPathSync(String(owner.statePath || ""))) !== normalizedFile) return false;
    const expectedDir = path.join(root, "simple_cluster", "tmp", "cluster_scheduler");
    if (comparablePath(path.dirname(fullPath)) !== comparablePath(expectedDir) || !/^[A-Za-z0-9._-]+_state\.json$/.test(path.basename(fullPath))) return false;
    const normalizePlan = (value: unknown) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const plan = normalizePlan(state?.plan);
    if (!plan || normalizePlan(owner.planFile) !== plan) return false;
    const operationId = String(owner.operationId || "").trim();
    const runId = String(owner.runId || "").trim();
    if (!operationId || !runId || operationId !== runId || !String(owner.attemptId || "").trim()) return false;
    return state?.schedulerTerminal === true && !(state.running_experiments || []).length && !(state.testing_experiments || []).length;
  } catch { return false; }
}

function realPathSync(value: string): string {
  return require("node:fs").realpathSync(value);
}

async function localCandidates(root: string, signal?: AbortSignal, retention?: RetentionIndex, blocked?: Map<string, BlockedRow>): Promise<Candidate[]> {
  signal?.throwIfAborted();
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("本机项目根目录不是普通目录；已停止扫描。");
  const realRoot = await fs.realpath(root);
  const rootDevice = (await fs.stat(realRoot)).dev;
  const rows: Candidate[] = [];
  for (const baseRelative of ["simple_cluster/tmp", "tmp", "simple_cluster/console_logs", "simple_cluster/tmux_logs"]) {
    const base = path.join(realRoot, ...baseRelative.split("/"));
    let baseStat;
    try { baseStat = await fs.lstat(base); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || baseStat.dev !== rootDevice || await fs.realpath(base) !== base) continue;
    const queue = [base];
    let scannedDirectories = 0;
    let scannedEntries = 0;
    while (queue.length) {
      signal?.throwIfAborted();
      const parent = queue.shift()!;
      scannedDirectories += 1;
      if (scannedDirectories > MAX_SCAN_DIRECTORIES) throw new Error(`本机临时目录超过 ${MAX_SCAN_DIRECTORIES} 个，已停止不完整扫描`);
      if ((await fs.stat(parent)).dev !== rootDevice || await fs.realpath(parent) !== parent) continue;
      const directory = await fs.opendir(parent);
      try {
        for await (const entry of directory) {
          signal?.throwIfAborted();
          scannedEntries += 1;
          if (scannedEntries > MAX_SCAN_ENTRIES) throw new Error(`本机临时目录超过 ${MAX_SCAN_ENTRIES} 个条目，已停止不完整扫描`);
          const full = path.join(parent, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { if (!protectedName(entry.name)) queue.push(full); continue; }
          const dryRun = /^dry-run-workers-\d+-[0-9a-f]{12}\.json$/.test(entry.name);
          const relative = path.relative(realRoot, full).split(path.sep).join("/");
          const schedulerState = relative.startsWith("simple_cluster/tmp/cluster_scheduler/") && relative.endsWith("_state.json");
          if (!entry.isFile() || protectedName(entry.name) || (!candidateExtensions.has(path.extname(entry.name).toLowerCase()) && !dryRun && !schedulerState)) continue;
          const stat = await fs.lstat(full, { bigint: true });
          if (stat.dev !== BigInt(rootDevice) || stat.nlink !== 1n || schedulerState && stat.size > 2n * 1024n * 1024n) continue;
          // Managed logs/caches are strictly version-based. Protected generations (current,
          // previous, active) never become candidates and the legacy 7-day cutoff must never
          // reach them; managed-but-unowned files are listed read-only. Only unmanaged legacy
          // junk keeps the historical 7-day rule.
          const token = candidateIdentity(relative, stat);
          const blockedCopy = blocked?.get(relative);
          if (blockedCopy && blockedCopy.workers.includes("local")) {
            rows.push({ workerId: "local", path: relative, fullPath: full, type: "file",
              bytes: Number(stat.size), modifiedAt: Number(stat.mtimeMs) / 1000,
              purpose: blockedPurpose(blockedCopy), token, retentionStale: true });
            continue;
          }
          const ownership = retention ? retentionOwnership(retention, relative) : "unknown-manifest";
          if (ownership === "protected") {
            // Version-based blocking evidence outranks the queue's current-window view: the file
            // physically holds an incoming run, so it is exactly what confirmed cleanup must offer.
            const blockedRow = blocked?.get(relative);
            if (!blockedRow) continue;
            rows.push({ workerId: "local", path: relative, fullPath: full, type: "file", bytes: Number(stat.size), modifiedAt: Number(stat.mtimeMs) / 1000, purpose: blockedPurpose(blockedRow), token, retentionStale: true });
            if (rows.length > MAX_CLEANUP_CANDIDATES) throw new Error(`本机候选文件超过 ${MAX_CLEANUP_CANDIDATES} 个，请缩小审核范围`);
            continue;
          }
          if (ownership === "unowned" || ownership === "unknown-manifest") {
            rows.push({ workerId: "local", path: relative, fullPath: full, type: "file", bytes: Number(stat.size), modifiedAt: Number(stat.mtimeMs) / 1000,
              purpose: ownership === "unknown-manifest" ? "受管前缀但缺少保留清单，无法判定两代归属（仅预览，不会删除）" : "受管前缀内但不属于任何已知代际的归属清单（仅预览，不会删除）",
              token, previewOnly: true });
            if (rows.length > MAX_CLEANUP_CANDIDATES) throw new Error(`本机候选文件超过 ${MAX_CLEANUP_CANDIDATES} 个，请缩小审核范围`);
            continue;
          }
          const staleRetention = ownership === "stale" ? isStaleRetentionRow(retention!, relative) : undefined;
          // Backup history copies are version-bound ("original + at most one"), never age-bound:
          // they are offered as confirmed-cleanup candidates immediately, because refusing new
          // writes forever until 7 days pass would deadlock the very editor flow they protect.
          const backupCopy = relative.startsWith("simple_cluster/tmp/backups/") && entry.name.endsWith(".bak");
          if (schedulerState) {
            let state: any;
            try { state = JSON.parse(await fs.readFile(full, "utf8")); } catch { continue; }
            if (!schedulerStateCleanupOwnerMatches(realRoot, full, state)) continue;
          }
          const purpose = backupCopy ? "原文件的历史副本（每个来源最多一份；确认清理后同名写入才会生成新副本）" : staleRetention ? `已超出该任务两代保留窗口（当前＋上一次）：${staleRetention.taskKey.slice(0, 120)}` : relative.includes("/cluster_scheduler/logs/") ? "单个 Job 的训练或测试输出日志，旧内容用于历史排错" : relative.includes("/cluster_scheduler/") && relative.endsWith(".log") ? "Plan 调度过程日志" : schedulerState ? "已终止 Plan 的专属调度状态（按代际审核）" : dryRun ? "Plan 预演的 Worker 分配快照" : relative.includes("/tmux_logs/") ? "tmux 会话输出副本" : "插件临时工作文件";
          rows.push({ workerId: "local", path: relative, fullPath: full, type: "file", bytes: Number(stat.size), modifiedAt: Number(stat.mtimeMs) / 1000, purpose, token, retentionStale: staleRetention || backupCopy ? true : undefined });
          if (rows.length > MAX_CLEANUP_CANDIDATES) throw new Error(`本机候选文件超过 ${MAX_CLEANUP_CANDIDATES} 个，请缩小审核范围`);
        }
      } finally { await directory.close().catch(() => undefined); }
    }
  }
  return rows;
}

async function deleteLocalCandidates(root: string, rows: Candidate[], skipped: string[], workerId: string): Promise<void> {
  const rootInfo = await fs.lstat(root).catch((error: Error) => { throw new Error(`PARENT_CD_FAILED：无法核验本机项目根目录：${error.message}`); });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("PARENT_CD_FAILED：本机项目根目录不是普通目录。");
  const realRoot = await fs.realpath(root).catch((error: Error) => { throw new Error(`PARENT_CD_FAILED：无法解析本机项目根目录：${error.message}`); });
  type Entry = { row: Candidate; full: string; parent: string };
  const entries: Entry[] = [];
  for (const row of rows) {
    if (row.previewOnly) { skipped.push(`${workerId} · ${row.path}（仅预览项不允许删除）`); continue; }
    try {
      const parts = row.path.split("/");
      const allowedRoot = parts[0] === "tmp"
        || parts[0] === "simple_cluster" && ["tmp", "console_logs", "tmux_logs"].includes(parts[1]);
      if (parts.some(part => !part || part === "." || part === "..") || !allowedRoot) throw new Error("缓存路径超出允许范围");
      const full = path.join(realRoot, ...parts);
      const stat = await fs.lstat(full, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || candidateIdentity(row.path, stat) !== row.token) throw new Error(`本机候选已变化：${row.path}`);
      const parent = path.dirname(full);
      const leaf = path.basename(full);
      const parentInfo = await fs.lstat(parent).catch((error: Error) => { throw new Error(`PARENT_CD_FAILED：无法核验目标父目录：${error.message}`); });
      const parentReal = await fs.realpath(parent).catch((error: Error) => { throw new Error(`PARENT_CD_FAILED：无法解析目标父目录：${error.message}`); });
      const parentRelative = path.relative(realRoot, parentReal);
      if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\\")
        || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.dev !== Number(stat.dev)
        || parentReal !== parent || parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error("PARENT_CD_FAILED");
      entries.push({ row, full, parent });
    } catch (error) { skipped.push(`${workerId} · ${row.path}（${String(error && (error as Error).message || error).slice(0, 80)}）`); }
  }
  if (!entries.length) return;
  // Mac 适配：同一确认批次仍逐项交给隔离删除器执行（cwd 为已核验父目录、删除前 fingerprint 复核、
  // Darwin libproc 句柄证明与两次绝对路径确认），一个目标一次子进程，绝不合并成整批删除。
  for (const entry of entries) {
    const row = entry.row;
    const full = entry.full;
    const immediatelyBeforeDelete = await fs.lstat(full, { bigint: true }).catch(() => undefined);
    if (!immediatelyBeforeDelete || !immediatelyBeforeDelete.isFile() || immediatelyBeforeDelete.isSymbolicLink()
      || immediatelyBeforeDelete.nlink !== 1n || candidateIdentity(row.path, immediatelyBeforeDelete) !== row.token) {
      skipped.push(`${workerId} · ${row.path}（执行器复核发现目标已变化，未删除）`); continue;
    }
    const { fingerprintCacheFile } = require("../mac/CacheDelete");
    const fingerprint = fingerprintCacheFile(full, row.path);
    if (fingerprint.token !== row.token) { skipped.push(`${workerId} · ${row.path}（执行器复核发现目标已变化，未删除）`); continue; }
    const approval = { root: realRoot, relative: row.path, fullPath: full, ...fingerprint,
      confirm: true, secondConfirmation: true, confirmedAbsolutePath: full,
      handleProbe: path.join(vscode.extensions.getExtension("simple-local.simple-sftp-mac")?.extensionPath || "", "mac_cleanup_handles.py") };
    let failure = "";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("../mac/CacheDelete"), JSON.stringify(approval)], {
        cwd: entry.parent, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe"],
      });
      let message = "";
      child.stderr.on("data", data => { message = (message + String(data)).slice(-500); });
      child.on("error", error => reject(new Error(`PARENT_CD_FAILED：无法在已核验父目录启动删除程序：${String(error)}`)));
      child.on("close", code => code === 0 ? resolve() : reject(new Error(message || "PARENT_CD_FAILED")));
    }).catch(error => { failure = String(error && (error as Error).message || error); });
    let stillThere = true;
    try { await fs.lstat(full); } catch (error: any) { if (error?.code === "ENOENT") stillThere = false; else throw error; }
    if (!stillThere) continue;
    if (!failure) throw new Error(`本机删除后仍存在：${row.path}`);
    skipped.push(`${workerId} · ${row.path}（${failure.slice(0, 80)}）`);
  }
}
function cleanupReadError(error: any): string {
  const code = String(error?.cause?.code || error?.code || "").slice(0, 80);
  const message = String(error?.message || error || "清单读取失败").slice(0, 300);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(`${message} ${code}`)
    ? `Agent 连接尚未就绪或已中断${code ? `（${code}）` : ""}；连接恢复后会重新读取，也可点击刷新候选。`
    : message;
}

function completedCleanupCandidates(result: any): Candidate[] {
  if (result?.status !== "completed" || !Array.isArray(result.candidates))
    throw new Error(String(result?.message || "服务器未返回完整候选清单；请刷新候选，不能将此响应视为零候选。"));
  if (result.candidates.length > MAX_CLEANUP_CANDIDATES) throw new Error("服务器候选清单超过审核上限");
  const paths = new Set<string>();
  for (const row of result.candidates) {
    const parts = typeof row?.path === "string" ? row.path.split("/") : [];
    if (row?.type !== "file" || !parts.length || parts.some((part: string) => !part || part === "." || part === ".." || part.includes("\\"))
      || !(parts[0] === "tmp" || (parts[0] === "simple_cluster" && ["tmp", "console_logs", "tmux_logs"].includes(parts[1])) || (parts[0] === "tmp" && ["console_logs", "tmux_logs"].includes(parts[1])))
      || typeof row.fullPath !== "string" || !path.posix.isAbsolute(row.fullPath)
      || typeof row.token !== "string" || !row.token || row.token.length > 256 || paths.has(row.path)
      || !Number.isFinite(row.bytes) || row.bytes < 0 || !Number.isFinite(row.modifiedAt))
      throw new Error("服务器候选清单格式或路径无效；已停止审核，请刷新候选。");
    paths.add(row.path);
  }
  return result.candidates;
}

export function openCacheCleanupPanel(contextProvider: () => CleanupContext, onDidChangeContext?: vscode.Event<void>): void {
  const panel = vscode.window.createWebviewPanel("simpleExperimentCacheCleanup", "缓存回收审核", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  let current = new Map<string, Candidate>();
  let busy = false;
  let disposed = false;
  let deleting = false;
  let refreshPending = false;
  let scanGeneration = 0;
  let scanAbort: AbortController | undefined;
  let loadedContext: CleanupContext | undefined;
  let reviewedKeys: string[] = [];
  let approvalStage = 0;
  const post = (message: any) => { if (!disposed) void panel.webview.postMessage(message); };
  const contextMatches = (context?: CleanupContext) => {
    const latest = contextProvider();
    return Boolean(context && context.client === latest.client && context.generation === latest.generation && context.localRoot === latest.localRoot);
  };
  const invalidateReview = () => { current.clear(); reviewedKeys = []; approvalStage = 0; loadedContext = undefined; };
  const refresh = async (contextChanged = false) => {
    if (disposed || deleting) { refreshPending = !disposed; return; }
    if (busy && !contextChanged) return;
    scanAbort?.abort();
    const abort = new AbortController();
    scanAbort = abort;
    const generation = ++scanGeneration;
    busy = true;
    invalidateReview();
    post({ type: "busy", message: "正在读取本机和各服务器的旧临时文件…" });
    try {
      const context = { ...contextProvider() };
      const endpoints = context.endpoints.filter(e => e.role === "worker");
      // Two-generation retention derives from the persisted queue facts; if unavailable, fall back to the legacy scan.
      let retention: RetentionIndex = { rows: [], byPath: new Map(), staleSessions: new Set(), protectedSessions: new Set(), ownedPaths: new Set(), caseInsensitive: process.platform === "win32" };
      if (context.retentionIndex) {
        try { retention = (await context.retentionIndex()) || retention; } catch { /* keep empty index */ }
      }
      let holds: Set<string> | undefined;
      try { holds = context.retentionHolds ? new Set(await context.retentionHolds()) : undefined; } catch { holds = undefined; }
      let blocked = new Map<string, BlockedRow>();
      try { blocked = new Map(((context.retentionBlocked ? await context.retentionBlocked() : undefined) || []).map(row => [row.path, row])); } catch { blocked = new Map(); }
      const scans: WorkerScan[] = [...(context.localRoot ? [{ id: "本机", count: 0, bytes: 0, status: "loading" as const }] : []), ...endpoints.map(e => ({ id: e.id, count: 0, bytes: 0, status: "loading" as const }))];
      const rowsBySource = new Map<string, Candidate[]>();
      const isCurrent = () => !disposed && !abort.signal.aborted && generation === scanGeneration && contextMatches(context);
      const publish = () => {
        if (!isCurrent()) return;
        const rows = [...rowsBySource.values()].flat();
        current = new Map(rows.map(row => [`${row.workerId}|${row.path}`, row]));
        const incomplete = scans.some(scan => scan.status === "unavailable");
        post({ type: "data", rows, scans: scans.map(scan => ({ ...scan })), busy,
          note: incomplete ? "候选读取未完整完成；连接失败或暂停审核的服务器不计为零候选。可审核已成功读取的路径。" : busy ? "正在读取；各来源完成后独立更新。" : "" });
      };
      publish();
      const readSource = async (id: string, workerId: string, read: () => Promise<Candidate[]>) => {
        try {
          const rows = await read();
          if (!isCurrent()) return;
          rowsBySource.set(id, rows.map(row => ({ ...row, workerId })));
          Object.assign(scans.find(scan => scan.id === id)!, { status: "ready", count: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) });
        } catch (error) {
          if (!isCurrent()) return;
          Object.assign(scans.find(scan => scan.id === id)!, { status: "unavailable", error: cleanupReadError(error) });
        }
        publish();
      };
      await Promise.all([
        ...(context.localRoot ? [readSource("本机", "local", async () => applyRetention(await localCandidates(context.localRoot!, abort.signal, retention, blocked), retention, holds, blocked))] : []),
        ...endpoints.map(e => readSource(e.id, e.id, async () => applyRetention(completedCleanupCandidates(await context.client.postWorkerAction(e.id, "preview-cache-cleanup", { opId: `cache-preview-${Date.now()}-${e.id}` }, { signal: abort.signal })), retention, holds, blocked))),
      ]);
      if (isCurrent()) { loadedContext = context; busy = false; publish(); }
    } catch (error) { if (generation === scanGeneration) post({ type: "error", message: cleanupReadError(error), busy: false }); }
    finally { if (generation === scanGeneration) busy = false; }
  };
  const contextSubscription = onDidChangeContext?.(() => {
    scanAbort?.abort();
    invalidateReview();
    if (deleting) { refreshPending = true; return; }
    void refresh(true);
  });
  panel.onDidDispose(() => { disposed = true; scanGeneration++; scanAbort?.abort(); invalidateReview(); contextSubscription?.dispose(); messageSubscription.dispose(); });
  const messageSubscription = panel.webview.onDidReceiveMessage(async message => {
    if (disposed) return;
    if (message?.type === "planOutputs") {
      if (deleting) { post({ type: "error", message: "当前清理尚未结束，请稍后审核 Plan 历史产物。" }); return; }
      const context = contextProvider();
      if (!context.reviewPlanOutputs) { post({ type: "error", message: "Plan 历史产物审核入口尚不可用。" }); return; }
      try { await context.reviewPlanOutputs(); }
      catch (error) { post({ type: "error", message: cleanupReadError(error) }); }
      return;
    }
    if (message?.type === "refresh") { await refresh(); return; }
    if (message?.type === "cancelReview") { reviewedKeys = []; approvalStage = 0; return; }
    if (message?.type === "review") {
      if (busy || !contextMatches(loadedContext)) { post({ type: "error", message: "连接或项目已变化，请刷新后重新审核" }); return; }
      const keys = message.keys;
      if (!Array.isArray(keys) || !keys.length || keys.length > 2000 || new Set(keys).size !== keys.length || keys.some(key => !current.has(key))) {
        panel.webview.postMessage({ type: "error", message: "选择已失效，请刷新后重新审核" }); return;
      }
      reviewedKeys = keys.slice(); approvalStage = 0; return;
    }
    if (message?.type === "confirmFirst") {
      if (!busy && contextMatches(loadedContext) && approvalStage === 0 && JSON.stringify(message.keys) === JSON.stringify(reviewedKeys) && reviewedKeys.length) approvalStage = 1;
      return;
    }
    if (message?.type !== "confirmSecond" || busy || approvalStage !== 1 || JSON.stringify(message.keys) !== JSON.stringify(reviewedKeys)) return;
    if (!contextMatches(loadedContext)) { invalidateReview(); post({ type: "error", message: "连接或项目已变化，请刷新后重新审核" }); return; }
    const context = loadedContext!;
    const keys = message.keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 2000 || new Set(keys).size !== keys.length || keys.some(key => !current.has(key))) {
      panel.webview.postMessage({ type: "error", message: "选择已失效，请刷新后重新审核" }); return;
    }
    busy = true;
    deleting = true;
    approvalStage = 0;
    let deletionAttempted = false;
    try {
      const skipped: string[] = [];
      const executeReviewedBatch = async (lease: any) => {
      await lease.assertHeld();
      // Fresh protection facts, fetched once for this confirmed batch, fail-closed on every error.
      let freshIndex: RetentionIndex | undefined;
      let freshHolds: Set<string> | undefined;
      let freshBlocked = new Map<string, BlockedRow>();
      try { freshIndex = context.retentionIndex ? await context.retentionIndex() : undefined; } catch { freshIndex = undefined; }
      try { freshHolds = context.retentionHolds ? new Set(await context.retentionHolds()) : undefined; } catch { freshHolds = undefined; }
      try { freshBlocked = new Map(((context.retentionBlocked ? await context.retentionBlocked() : undefined) || []).map(row => [row.path, row])); } catch { freshBlocked = new Map(); }
      const retentionStillDeletable = (row: Candidate): string | undefined => {
        if (row.previewOnly) return "仅预览归属";
        if (row.path.startsWith("simple_cluster/tmp/backups/") && row.path.endsWith(".bak"))
          return freshHolds === undefined ? "保留声明无法读取，保守不删" : undefined;
        if (freshBlocked.has(row.path) && freshHolds !== undefined) {
          const blocked = freshBlocked.get(row.path)!;
          if (!blocked.workers.includes(row.workerId)) return "该节点不属于待退出代";
          if ([...freshHolds].some(key => blocked.planFile && key.startsWith(blocked.planFile + "|"))) return "在途提交已声明保留";
          return undefined;
        }
        const ownership = freshIndex ? retentionOwnership(freshIndex, row.path) : "unknown-manifest";
        if (row.retentionStale) {
          if (!freshIndex) return "保留清单无法重算，保守不删";
          if (ownership !== "stale") return "重算后已受保护或归属未知";
          if (retentionRowHeld(row, freshIndex, freshHolds)) return "在途提交已声明保留";
          return undefined;
        }
        if (ownership === "protected") return "重算后已受保护";
        if (ownership === "unowned" || ownership === "unknown-manifest") return "重算后归属未知";
        return undefined;
      };
      const byWorker = new Map<string, Candidate[]>();
      for (const key of keys) { const row = current.get(key)!; if (!byWorker.has(row.workerId)) byWorker.set(row.workerId, []); byWorker.get(row.workerId)!.push(row); }
      for (const [workerId, rows] of byWorker) {
        if (disposed || !contextMatches(context)) throw new Error("连接或项目已变化，已停止后续删除，请重新审核");
        post({ type: "busy", message: `正在删除 ${workerId} 的 ${rows.length} 个已确认路径…` });
        if (workerId === "local") {
          if (!context.localRoot) throw new Error("本机项目根目录已失效");
          deletionAttempted = true;
          // Recompute protection immediately before deletion, fail-closed: if the retention index
          // or the claims store cannot be recomputed, stale/blocked rows are NOT deletable — an
          // unknown state never means "no protection".
          const deletable: Candidate[] = [];
          for (const row of rows) {
            if (disposed || !contextMatches(context)) throw new Error("连接或项目已变化，已停止后续删除，请重新审核");
            const why = retentionStillDeletable(row);
            if (why) skipped.push(`${workerId} · ${row.path}（${why}）`);
            else deletable.push(row);
          }
          if (deletable.length) { await lease.assertHeld(); await deleteLocalCandidates(context.localRoot, deletable, skipped, workerId); }
        } else {
          deletionAttempted = true;
          let kept = rows;
          try {
            const recheck: any = await context.client.postWorkerAction(workerId, "preview-cache-cleanup", { opId: `cache-recheck-${Date.now()}-${workerId}` });
            const fresh = new Set(completedCleanupCandidates(recheck).map((row: any) => `${row.path}\0${row.token}`));
            for (const row of rows) if (!fresh.has(`${row.path}\0${row.token}`)) skipped.push(`${workerId} · ${row.path}（重算预览后已受保护、被引用或已变化）`);
            kept = rows.filter(row => fresh.has(`${row.path}\0${row.token}`));
          } catch { /* 重算预览不可用：按保守策略整台本轮不删除 */ skipped.push(`${workerId}：重算预览失败，本轮不删除任何路径`); kept = []; }
          // The token recheck proves "still the same file"; the retention recheck proves "still
          // deletable under the current window, claims and blocked-admission facts".
          kept = kept.filter(row => { const why = retentionStillDeletable(row); if (why) skipped.push(`${workerId} · ${row.path}（${why}）`); return !why; });
          if (!kept.length) continue;
          const result: any = await context.client.postWorkerAction(workerId, "delete-cache-candidates", { opId: `cache-delete-${Date.now()}-${workerId}`, candidates: kept.map(row => ({ path: row.path, token: row.token })), confirm: true, pathConfirmed: true });
          if (result?.status !== "completed") throw new Error(`${workerId}: ${String(result?.message || "删除尚未确认完成，请刷新候选核对；不会自动重发删除。")}`);
        }
      }
      };
      if (!context.withRetentionLease) throw new Error("缓存删除缺少跨窗口租约，已停止。");
      await context.withRetentionLease(executeReviewedBatch);
      if (skipped.length) post({ type: "error", message: `已跳过 ${skipped.length} 个重算后新受保护、被引用或已变化的路径：${skipped.slice(0, 3).join("；")}${skipped.length > 3 ? "…" : ""}` });
      busy = false;
      deleting = false;
      refreshPending = false;
      await refresh();
    } catch (error) {
      const message = String(error);
      if (deletionAttempted) {
        busy = false;
        deleting = false;
        refreshPending = false;
        await refresh();
      }
      post({ type: "error", message, busy: false });
    }
    finally { busy = false; deleting = false; if (refreshPending) { refreshPending = false; await refresh(); } }
  });
  panel.webview.html = html(crypto.randomBytes(16).toString("base64"));
}
