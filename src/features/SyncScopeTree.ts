import * as vscode from "vscode";
import * as crypto from "node:crypto";
import type { ScopeIndexProgress } from "./SyncScopeMetadata";

export type ScopeObservation = { status: "present" | "not-listed" | "absent" | "unknown"; directory?: boolean; size?: number; modifiedAtMs?: number; observedAt?: string; error?: string };
export type ScopeEntry = { name: string; path: string; directory: boolean; selectable?: boolean; locations?: string[]; held?: boolean; size?: number; modifiedAtMs?: number; metadataError?: string; observations?: Record<string, ScopeObservation> };
export type ScopeStatus = { state: "same" | "different" | "remote-only" | "unknown"; detail: string; basis?: "metadata" | "content"; metadata?: Record<string, ScopeObservation>; issueSignature?: string; versions?: Record<string, { sha256: string; modifiedAtMs: number; latest?: "plan" | "local" | "candidate" | "same" | "manual" }>; copies?: Record<string, { modifiedAtMs: number; present: number; missing: number; needsSync: number; conflict: number; unverified: number }>; held?: boolean; unverified?: boolean };
export type ScopeRoot = {
  id: string;
  label: string;
  detail: string;
  selected: string[];
  indexLocations?: Array<{ id: string; label: string }>;
  rootSelectable?: boolean;
  excludable?: boolean;
  list: (relative: string, signal?: AbortSignal, roundId?: string) => Promise<ScopeEntry[] & { queryErrors?: string[]; observations?: Record<string, ScopeObservation> }>;
  refresh: (relative: string, signal?: AbortSignal, report?: (stage: string) => void) => Promise<Record<string, ScopeStatus>>;
  summary?: (relative: string, signal?: AbortSignal, report?: (stage: string, progress?: ScopeIndexProgress) => void, publish?: (statuses: Record<string, ScopeStatus>) => void, roundId?: string) => Promise<Record<string, ScopeStatus>>;
  dispose?: () => void;
  watch?: (invalidate: (reason: string) => void) => () => void;
  save: (paths: string[], excluded?: string[]) => Promise<void>;
  remove?: (relative: string, endpointId: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  removeAllWorkers?: (relative: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  retain?: (relative: string, endpointId: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  mergeLatest?: (relative: string, report: (stage: string) => void) => Promise<{ completed: string[]; errors: string[] } | false>;
  batch?: (action: "sync" | "delete", selected: string[], excluded: string[], report: (stage: string) => void, knownEntries: ScopeEntry[]) => Promise<{ completed: string[]; errors: string[] } | false>;
};

export function openSyncScopeTree(title: string, roots: ScopeRoot[]): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel("simpleExperimentMac.syncScopeTree", title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString("base64");
  panel.webview.html = scopeTreeHtml(nonce);
  const reads = new Set<AbortController>();
  const refreshReads = new Set<AbortController>();
  const cancelReads = () => { for (const controller of reads) controller.abort(); };
  const subscriptions = roots.flatMap(root => root.watch ? [root.watch(reason => { cancelReads(); void panel.webview.postMessage({ type: "indexInvalidated", reason }); })] : []);
  panel.onDidDispose?.(() => { cancelReads(); for (const unsubscribe of subscriptions) unsubscribe(); for (const root of roots) root.dispose?.(); });
  panel.webview.onDidReceiveMessage(async (message: any) => {
    const id = String(message?.id || "");
    const root = roots.find((item) => item.id === message?.rootId);
    const read = ["list", "refresh", "summary"].includes(message?.type) ? new AbortController() : undefined;
    if (read) reads.add(read);
    if (read && ["refresh", "summary"].includes(message?.type)) refreshReads.add(read);
    if (["save", "remove", "removeAllWorkers", "retain", "batchSync", "batchDelete", "mergeLatest"].includes(message?.type)) cancelReads();
    try {
      if (message?.type === "ready") {
        await panel.webview.postMessage({ type: "init", roots: roots.map(({ id, label, detail, selected, rootSelectable, excludable, summary, indexLocations }) => ({ id, label, detail, selected, rootSelectable, excludable, summary: Boolean(summary), indexLocations })) });
        return;
      }
      if (!root) throw new Error("同步范围目标已失效。");
      if (message.type === "cancelRefresh") { if (message.cancelReads) cancelReads(); else for (const controller of refreshReads) controller.abort(); return; }
      if (message.type === "list") {
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("目录路径不安全。");
        const entries = await root.list(relative, read?.signal, String(message.roundId || "0"));
        await panel.webview.postMessage({ type: "children", id, rootId: root.id, path: relative, entries, queryErrors: entries.queryErrors || [], observations: entries.observations });
      } else if (message.type === "refresh" || message.type === "summary") {
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("校验目录路径不安全。");
        let sequence = 0;
        const report = (stage: string, progress?: ScopeIndexProgress) => { if (!read?.signal.aborted) void panel.webview.postMessage({ type: "readProgress", id, rootId: root.id, path: relative, stage, progress, sequence: ++sequence }); };
        const publish = (statuses: Record<string, ScopeStatus>) => { if (!read?.signal.aborted) void panel.webview.postMessage({ type: "status", id, rootId: root.id, path: relative, statuses, complete: false }); };
        if (message.type === "summary" && !root.summary) throw new Error("当前范围不支持递归文件信息");
        const statuses = message.type === "summary" ? await root.summary!(relative, read?.signal, report, publish, String(message.roundId || "0")) : await root.refresh(relative, read?.signal, report);
        read?.signal.throwIfAborted();
        await panel.webview.postMessage({ type: "status", id, rootId: root.id, path: relative, statuses, complete: true, refreshedAt: new Date().toISOString() });
      } else if (message.type === "save") {
        const paths = Array.isArray(message.paths) ? message.paths.map(String) : [];
        const excluded = Array.isArray(message.excluded) ? message.excluded.map(String) : [];
        if (paths.some((value: string) => value !== "." && (value.startsWith("/") || value.split("/").some((part: string) => !part || part === "." || part === ".."))))
          throw new Error("选择路径不安全。");
        if (excluded.some((value: string) => !value || value === "." || value.startsWith("/") || value.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("排除路径不安全。");
        await root.save(paths, excluded);
        root.selected = paths;
        await panel.webview.postMessage({ type: "saved", id, rootId: root.id, paths });
      } else if (message.type === "batchSync" || message.type === "batchDelete") {
        if (!root.batch) throw new Error("当前范围不支持批量操作。");
        const selected = Array.isArray(message.paths) ? message.paths.map(String) : [];
        const excluded = Array.isArray(message.excluded) ? message.excluded.map(String) : [];
        const knownEntries: ScopeEntry[] = Array.isArray(message.entries) ? message.entries.slice(0, 10000).filter((entry: any) =>
          entry && typeof entry.path === "string" && selected.includes(entry.path) && typeof entry.directory === "boolean" &&
          Array.isArray(entry.locations) && entry.locations.every((id: unknown) => typeof id === "string") &&
          !entry.path.startsWith("/") && entry.path.split("/").every((part: string) => part && part !== "." && part !== "..")
        ).map((entry: any) => ({ name: String(entry.name || entry.path.split("/").at(-1)), path: entry.path, directory: entry.directory,
          locations: entry.locations.map(String), selectable: entry.selectable !== false })) : [];
        if (selected.some((value: string) => value !== "." && (value.startsWith("/") || value.split("/").some((part: string) => !part || part === "." || part === ".."))) ||
            excluded.some((value: string) => !value || value === "." || value.startsWith("/") || value.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("批量选择包含不安全路径。");
        let sequence = 0;
        const report = (stage: string) => { void panel.webview.postMessage({ type: "actionProgress", id, rootId: root.id, path: "批量操作", stage, sequence: ++sequence }); };
        const result = await root.batch(message.type === "batchSync" ? "sync" : "delete", selected, excluded, report, knownEntries);
        if (result !== false && result.errors.length) console.error(`[SimpleExperiment SyncScope] ${message.type} ${root.id}: ${result.errors.join("；").slice(0, 8000)}`);
        await panel.webview.postMessage({ type: result === false ? "actionCancelled" : "batchDone", id, rootId: root.id,
          completed: result === false ? [] : result.completed, affected: selected, errors: result === false ? [] : result.errors });
      } else if (message.type === "mergeLatest") {
        if (root.id !== "workers" || !root.mergeLatest) throw new Error("仅 Worker ↔ Worker 模式支持按最新版合并。");
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === ".."))) throw new Error("合并路径不安全。");
        let sequence = 0;
        const report = (stage: string) => { void panel.webview.postMessage({ type: "actionProgress", id, rootId: root.id, path: relative, stage, sequence: ++sequence }); };
        const result = await root.mergeLatest(relative, report);
        await panel.webview.postMessage({ type: result === false ? "actionCancelled" : "batchDone", id, rootId: root.id,
          completed: result === false ? [] : result.completed, affected: [relative], errors: result === false ? [] : result.errors });
      } else if (message.type === "remove" || message.type === "removeAllWorkers" || message.type === "retain") {
        const relative = String(message.path || "");
        if (!relative || relative === "." || relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === "..")) throw new Error("操作路径不安全。");
        const endpointId = String(message.endpointId || "");
        if (message.type !== "removeAllWorkers" && !endpointId) throw new Error("请明确选择一个目标位置。");
        let changed: boolean | void;
        let sequence = 0;
        const report = (stage: string) => { void panel.webview.postMessage({ type: "actionProgress", id, rootId: root.id, path: relative, stage, sequence: ++sequence }); };
        if (message.type === "remove") {
          if (!root.remove) throw new Error("当前范围不支持删除。");
          changed = await root.remove(relative, endpointId, message.directory === true, report);
        } else if (message.type === "removeAllWorkers") {
          if (!root.removeAllWorkers) throw new Error("当前范围不支持批量删除。");
          changed = await root.removeAllWorkers(relative, message.directory === true, report);
        } else {
          if (!root.retain) throw new Error("当前范围不支持选定版本。");
          changed = await root.retain(relative, endpointId, message.directory === true, report);
        }
        await panel.webview.postMessage({ type: changed === false ? "actionCancelled" : "actionDone", id, rootId: root.id, path: relative, action: message.type, directory: message.directory === true });
      }
    } catch (error) {
      if (read?.signal.aborted) {
        await panel.webview.postMessage({ type: "readCancelled", id, requestType: message?.type, rootId: root?.id, path: String(message?.path || ".") });
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[SimpleExperiment SyncScope] ${String(message?.type)} ${root?.id || ""} ${String(message?.path || ".")}: ${detail}`);
      await panel.webview.postMessage({ type: "error", id, requestType: message?.type, rootId: root?.id, path: String(message?.path || "."),
        affected: Array.isArray(message?.paths) ? message.paths : [String(message?.path || ".")], message: detail });
    } finally { if (read) { reads.delete(read); refreshReads.delete(read); } }
  });
  return panel;
}

function scopeTreeHtml(nonce: string): string {
  return String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}
h2{font-size:16px;margin:0 0 10px}.muted{color:var(--vscode-descriptionForeground);margin:6px 0 12px}
#tabs{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}
button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}button.active{outline:1px solid var(--vscode-focusBorder)}
#tree{border:1px solid var(--vscode-panel-border);max-height:65vh;overflow:auto;padding:6px}.row{display:flex;align-items:center;min-height:30px;gap:7px;white-space:nowrap;border-radius:7px}.row:hover{background:var(--vscode-list-hoverBackground)}.row.transfer-scope{background:color-mix(in srgb,var(--vscode-focusBorder) 9%,var(--vscode-editor-background));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vscode-focusBorder) 16%,transparent)}.row.transfer-scope:hover{background:color-mix(in srgb,var(--vscode-focusBorder) 14%,var(--vscode-editor-background))}
.scope-legend{border-radius:7px;padding:2px 7px;background:color-mix(in srgb,var(--vscode-focusBorder) 9%,var(--vscode-editor-background));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vscode-focusBorder) 16%,transparent)}
.row label{cursor:pointer;min-width:150px;max-width:32%;overflow:hidden;text-overflow:ellipsis}.row .name.same{color:var(--vscode-testing-iconPassed,#43a047)}.row .name.different{color:var(--vscode-testing-iconFailed,#e53935)}.row .name.remote-only{color:var(--vscode-editorWarning-foreground,#d9822b)}.row .name.unknown{color:var(--vscode-descriptionForeground)}.row input{accent-color:var(--vscode-focusBorder)}.twisty{width:21px;min-width:21px;text-align:center;padding:0;background:transparent;color:var(--vscode-foreground)}.row-detail{display:flex;gap:6px;flex-wrap:wrap;padding:7px 8px;background:var(--vscode-editorWidget-background);border-left:2px solid var(--vscode-focusBorder)}.version{border:1px solid var(--vscode-panel-border);padding:3px 6px;overflow-wrap:anywhere;max-width:360px;font-size:11px}.version button{font-size:11px;padding:2px 5px;margin-left:4px}.more{margin-left:auto;white-space:nowrap;font-size:11px;padding:3px 7px}.candidate{color:var(--vscode-editorWarning-foreground,#d9822b)}.held{color:var(--vscode-editorWarning-foreground,#d9822b);font-size:11px}
.filterbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0}.filterbar button{font-size:12px}.filterbar .muted{margin:0}
#indexProgress{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px;font-size:12px}.index-copy{padding:4px 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}.index-copy.reading{color:var(--vscode-descriptionForeground)}.index-copy.complete{color:var(--vscode-testing-iconPassed,#43a047)}.index-copy.partial,.index-copy.failed{color:var(--vscode-editorWarning-foreground,#d9822b)}.row-delete{font-size:11px;padding:3px 7px}.bottom-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
#status{min-height:20px;margin:8px 0;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere}#status.busy::before{content:'◌';display:inline-block;margin-right:7px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#save{margin-top:8px}.badge{margin-left:8px;font-size:12px;white-space:pre-line;overflow-wrap:anywhere;max-width:60%;min-width:0}.badge.same{display:none}.badge span{display:block;white-space:normal;overflow-wrap:anywhere;max-width:100%}.same{color:var(--vscode-testing-iconPassed,#43a047)}.different{color:var(--vscode-testing-iconFailed,#e53935)}.remote-only{color:var(--vscode-editorWarning-foreground,#d9822b)}.unknown{color:var(--vscode-descriptionForeground)}.focus-conflict{outline:1px solid var(--vscode-focusBorder);background:var(--vscode-list-focusBackground)}
</style></head><body><h2>同步范围</h2><div id="guide" class="muted">自动读取索引并校验内容；未变化文件复用哈希，时间不同但内容相同仍显示一致。</div><div class="muted"><span class="same">绿色：当前比较项相同</span>　<span id="remote-only-legend" class="remote-only">橙色：仅 Worker 内容同版</span>　<span class="different">红色：差异或缺失</span>　<span id="scope-legend" class="scope-legend">浅色圆角背景：本机 ↔ Worker 传输范围</span></div><div id="tabs"></div><div id="detail" class="muted"></div><button id="refresh" class="secondary">刷新文件状态</button> <button id="compare" class="secondary">比较文件内容（重新校验）</button> <button id="nextConflict" class="secondary">定位下一个冲突</button><div class="filterbar"><button id="showSame" class="secondary">显示一致项</button><button id="filterIssues" class="secondary">仅显示缺失和差异</button><button id="clearIssueFilter" class="secondary" hidden>显示全部</button><button id="selectFiltered" class="secondary" hidden>勾选当前结果</button><button id="unselectFiltered" class="secondary" hidden>取消勾选当前结果</button><span id="filterDetail" class="muted"></span></div><div id="status" role="status" aria-live="polite"></div><div id="indexProgress" aria-label="各位置文件索引状态"></div><div class="filterbar"><button id="operationSelection">选择操作项</button><button id="editScope" class="secondary">编辑同步范围</button><span id="selectionDetail" class="muted"></span></div><div id="tree"></div><div class="bottom-actions"><button id="save">保存当前范围</button> <button id="batchSync" class="secondary">批量同步勾选项</button> <button id="deleteSelection" class="secondary" title="独立选择删除目标，支持仅在服务器存在的文件，不改变同步范围">选择删除项</button> <button id="batchDelete" class="secondary" title="选择删除位置并两次确认完整路径">一键删除勾选项</button></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let roots=[],active=null,serial=0,pendingScopeSelected=null;const views=new Map();
const listQueue=[],listRunning=new Map();
const tabs=document.getElementById('tabs'),tree=document.getElementById('tree'),status=document.getElementById('status'),detail=document.getElementById('detail');
function state(){return views.get(active.id)}
function renderIndexProgress(){const container=document.getElementById('indexProgress');container.replaceChildren();if(!active)return;const view=state(),rows=[...view.indexProgress.values()],complete=rows.filter(row=>row.state==='complete').length;const title=document.createElement('span');title.className='index-copy';title.textContent=rows.length?'文件索引 '+complete+'/'+rows.length+(complete===rows.length?' · 全部完成':' · 尚未全部完成'):'文件索引：等待查询';container.appendChild(title);for(const row of rows){const item=document.createElement('span');item.className='index-copy '+row.state;item.textContent=(row.label||row.endpointId)+'：'+row.detail;container.appendChild(item)}}
function resetIndexProgress(view){view.indexExpired=false;view.expiryTicket=null;view.indexProgress=new Map((view.indexLocations||[]).map(row=>[row.id,{endpointId:row.id,label:row.label,state:'reading',detail:'等待索引'}]));renderIndexProgress()}
function interruptIndexProgress(view,detail='已暂停，尚未完成'){for(const row of view.indexProgress.values())if(row.state==='reading'){row.state='partial';row.detail=detail}renderIndexProgress()}
function expireIndexView(view){view.indexExpired=true;for(const row of view.indexProgress.values())if(row.state==='complete'){row.state='reading';row.detail='文件变更，等待增量核实'}const unknown={status:'unknown',error:'文件变更，等待增量核实'};for(const [path,health] of Object.entries(view.statuses))view.statuses[path]={state:'unknown',basis:'metadata',unverified:true,detail:'文件变更，等待增量核实',metadata:health.metadata?Object.fromEntries(Object.keys(health.metadata).map(id=>[id,unknown])):undefined};for(const [parent,children] of view.children)view.children.set(parent,children.map(entry=>({...entry,locations:[],observations:Object.fromEntries(Object.keys(entry.observations||{}).map(id=>[id,unknown]))})));if(active&&views.get(active.id)===view){renderIndexProgress();renderTree()}}
// A completed index remains built. Wall time only asks the next explicit browse to revalidate its observation.
function scheduleIndexExpiry(view){view.checkedAt=Date.now();view.expiryTicket=null}
function indexObservationNeedsRefresh(view){return view.checkedAt!==undefined&&Date.now()-view.checkedAt>=30000&&!view.pending.size}
function parentPath(path){const index=path.lastIndexOf('/');return index<0?'.':path.slice(0,index)}
function issueTree(view){
  if(!view.issueFilterOn)return null;
  const files=Object.keys(view.statuses).filter(path=>path!=='.'&&!view.statuses[path]?.copies&&(view.statuses[path]?.issueSignature||view.statuses[path]?.state==='unknown'&&(view.statuses[path]?.metadata||view.statuses[path]?.versions))&&(!view.issueSignature||view.statuses[path].issueSignature===view.issueSignature)).sort();
  const matched=new Set(files),visible=new Set(['.']),total=new Map(),same=new Map(),checked=new Map();
  for(const path of Object.keys(view.statuses)){
    const health=view.statuses[path];if(path==='.'||health.copies)continue;
    for(let parent=parentPath(path);;parent=parentPath(parent)){total.set(parent,(total.get(parent)||0)+1);if(matched.has(path))same.set(parent,(same.get(parent)||0)+1);if(parent==='.')break}
  }
  for(const file of files){visible.add(file);same.set(file,1);for(let parent=parentPath(file);;parent=parentPath(parent)){visible.add(parent);if(parent==='.')break}}
  for(const file of files)if(view.batchSelected.has(file)){checked.set(file,1);for(let parent=parentPath(file);;parent=parentPath(parent)){checked.set(parent,(checked.get(parent)||0)+1);if(parent==='.')break}}
  const uniform=new Set([...visible].filter(path=>path!=='.'&&(same.get(path)||0)>0&&same.get(path)===total.get(path)));
  const children=new Map();for(const path of visible){if(path==='.')continue;const parent=parentPath(path),directory=!matched.has(path);const health=view.statuses[path];const locations=directory?Object.entries(health?.copies||{}).filter(([,copy])=>copy.present>0).map(([id])=>id):Object.keys(health?.versions||{});const item={name:path.slice(path.lastIndexOf('/')+1),path,directory,selectable:true,locations,held:health?.held};if(!children.has(parent))children.set(parent,[]);children.get(parent).push(item)}
  for(const rows of children.values())rows.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));
  return {files,uniform,children,counts:same,checked};
}
function shownChildren(path){const view=state(),rows=view.issueFilterOn?view.issueTree?.children.get(path)||[]:view.children.get(path);return rows?.filter(entry=>!view.hideSame||view.statuses[entry.path]?.state!=='same'||view.statuses[entry.path]?.unverified||Object.values(entry.observations||{}).some(copy=>copy.status==='unknown'||copy.status==='not-listed'))}
function showIssueFilter(view,signature){view.operationMode=false;view.scopeEditing=false;view.issueFilterOn=true;view.issueSignature=signature;for(const parent of issueTree(view).children.keys())view.expanded.add(parent);renderTree()}
function renderFilterControls(){const view=state(),on=Boolean(view.issueFilterOn),count=view.issueTree?.files.length||0;document.getElementById('filterIssues').hidden=on;document.getElementById('clearIssueFilter').hidden=!on;document.getElementById('selectFiltered').hidden=!on;document.getElementById('unselectFiltered').hidden=!on;document.getElementById('filterDetail').textContent=on?count+' 个异常文件'+(view.issueSignature?'，仅显示同类差异':'，可点文件“筛选同类”')+'；筛选勾选仅用于批量操作':''}
function pauseRefreshes(){listQueue.length=0;for(const view of views.values()){view.refreshQueue=[];view.refreshRequests.clear();view.pending.clear();view.listRequests.clear();view.listPending.clear();interruptIndexProgress(view)}}
function sendAction(type,entry,endpointId){const view=state();if(view.busyAction)return;pauseRefreshes();const id=String(++serial);view.busyAction={type,path:entry.path,id,sequence:0};status.className='busy';status.textContent='正在准备 '+entry.path+'，请核对确认页中的完整路径…';renderTree();vscode.postMessage({type,id,rootId:active.id,path:entry.path,endpointId,directory:entry.directory})}
function isExcluded(path){return [...state().excluded].some(item=>item===path||path.startsWith(item+'/'))}
function selected(path){if(isExcluded(path))return false;return [...state().selected].some(item=>item==='.'||item===path||path.startsWith(item+'/'))}
function childSelected(path){return [...state().selected].some(item=>path==='.'||item.startsWith(path+'/'))||selected(path)&&[...state().excluded].some(item=>item.startsWith(path+'/'))}
function hasExcludedChild(path){return [...state().excluded].some(item=>item.startsWith(path+'/'))}
function operationSelected(path){const view=state();return ![...view.operationExcluded].some(item=>item===path||path.startsWith(item+'/'))&&[...view.operationSelected].some(item=>item===path||path.startsWith(item+'/'))}
function setOperationSelection(path,checked){const view=state();if(path==='.') {view.operationSelected.clear();view.operationExcluded.clear();if(checked)for(const entry of shownChildren('.')||[])view.operationSelected.add(entry.path)}else if(checked){for(const item of [...view.operationExcluded])if(item===path||item.startsWith(path+'/'))view.operationExcluded.delete(item);if(!operationSelected(path)){for(const item of [...view.operationSelected])if(item.startsWith(path+'/'))view.operationSelected.delete(item);view.operationSelected.add(path)}}else{for(const item of [...view.operationSelected])if(item===path||item.startsWith(path+'/'))view.operationSelected.delete(item);if([...view.operationSelected].some(item=>path.startsWith(item+'/')))view.operationExcluded.add(path)}renderTree()}
function setSelection(path,checked){const view=state();if(view.issueFilterOn){for(const file of view.issueTree?.files||[])if(path==='.'||file===path||file.startsWith(path+'/')){if(checked)view.batchSelected.add(file);else view.batchSelected.delete(file)}renderTree();return}const set=view.selected,excluded=view.excluded;if(path==='.') {set.clear();excluded.clear();if(checked){if(!active.excludable)set.add('.');else for(const item of view.children.get('.')||[])if(item.selectable!==false)set.add(item.path)}}else if(checked){for(const item of [...excluded])if(item===path||item.startsWith(path+'/'))excluded.delete(item);if(!selected(path)){for(const item of [...set])if(item.startsWith(path+'/'))set.delete(item);set.add(path)}}else{for(const item of [...set])if(item===path||item.startsWith(path+'/'))set.delete(item);if([...set].some(item=>item==='.'||path.startsWith(item+'/')))excluded.add(path);else for(const item of [...excluded])if(item===path||item.startsWith(path+'/'))excluded.delete(item)}renderTree()}
function versionTime(version){if(!version?.modifiedAtMs)return '时间未知';const date=new Date(version.modifiedAtMs);if(Number.isNaN(date.getTime()))return '时间未知';const two=value=>String(value).padStart(2,'0');return date.getFullYear()+'-'+two(date.getMonth()+1)+'-'+two(date.getDate())+' '+two(date.getHours())+':'+two(date.getMinutes())+':'+two(date.getSeconds())}
function versionRole(version){return version?.latest==='plan'?'Plan 最新运行':version?.latest==='manual'?'手动选定':version?.latest==='local'?'本机基准':version?.latest==='candidate'?'时间最新候选':version?.latest==='same'?'与其他 Worker 同内容':''}
function folderCopyText(id,copy,present){const name=id==='local'?'本机':id;if(!present&&!copy.present&&!copy.unverified)return name+' 全部缺失'+(copy.missing?' '+copy.missing:'');const issues=[copy.missing?'缺失 '+copy.missing:'',copy.needsSync?'差异 '+copy.needsSync:'',copy.conflict?'内容冲突 '+copy.conflict:'',copy.unverified?'未知 '+copy.unverified:''].filter(Boolean);return name+' '+versionTime(copy)+(issues.length?' · '+issues.join(' · '):'')}
function observedSize(value){if(!Number.isFinite(value)||value<0)return '';if(value<1024)return value+' B';let size=value,unit=0;const units=['B','KB','MB','GB','TB'];while(size>=1024&&unit<units.length-1){size/=1024;unit++}return size.toFixed(1)+' '+units[unit]}
function observedText(id,copy,detail=false){const name=id==='local'?'本机':id;if(copy.status==='unknown')return name+' 查询失败'+(detail&&copy.error?'：'+copy.error:'');if(copy.status==='not-listed')return name+' 本轮未列出';if(copy.status==='absent')return name+' 不存在';return name+' '+(copy.directory?'目录存在':'文件存在')+(!copy.directory&&observedSize(copy.size)?' · '+observedSize(copy.size):'')+(detail&&Number.isFinite(copy.modifiedAtMs)?' · 修改于 '+versionTime(copy):'')}
function copyGroups(entry,health){
  const locations=[...new Set([...Object.keys(entry.observations||{}),...Object.keys(health?.versions||{}),...Object.keys(entry.directory?health?.copies||{}:{}),...(entry.locations||[])])],groups=new Map();
  for(const id of locations){const observed=entry.observations?.[id],version=health?.versions?.[id],copy=entry.directory?health?.copies?.[id]:null;let text,key;
    if(observed?.status==='unknown'){text=(observed.error==='正在读取'?'读取中':'查询失败')+' · 不代表缺失';key='unknown:'+String(observed.error||'')}
    else if(observed?.status==='not-listed'){text='本轮未列出 · 尚不能确认缺失';key='not-listed'}
    else if(observed?.status==='absent'){text='确认缺失';key='absent'}
    else if(copy){text=folderCopyText('',copy,observed?.status==='present'||copy.present>0).trim();key='folder:'+JSON.stringify(copy)}
    else if(version){text=versionTime(version)+' · SHA256 '+version.sha256.slice(0,12);key='hash:'+version.sha256.toLowerCase()+':'+version.modifiedAtMs}
    else if(observed){text=(observed.directory?'目录存在':'文件存在')+(!observed.directory?' · '+observedSize(observed.size):'')+(Number.isFinite(observed.modifiedAtMs)?' · '+versionTime(observed):'');key='metadata:'+JSON.stringify([observed.directory,observed.size,observed.modifiedAtMs])}
    else{text='尚未读取文件信息';key='unknown'}
    let group=groups.get(key);if(!group){group={ids:[],text,observations:{}};groups.set(key,group)}group.ids.push(id);if(observed)group.observations[id]=observed;
  }
  return [...groups.values()];
}
function groupText(group){return group.ids.map(id=>id==='local'?'本机':id).join('、')+' · '+group.text}
function paintStatus(badge,health,directory,locations){if(!health){badge.textContent='尚未读取文件信息';return}if(health.state==='same')return;if(directory){const copies=Object.entries(health.copies||{});if(copies.length){const fullMissing=copies.some(([id])=>locations&&!locations.includes(id));const summary=[];if(!fullMissing)for(const part of health.detail.split(' · ')){const count=Number(part.match(/^([0-9]+) /)?.[1]||0);if(!count)continue;if(part.includes('待更新或冲突'))summary.push(count+' 个文件内容不同或缺失');else if(part.includes('仅 Worker 一致'))summary.push(count+' 个文件本机缺失或不同');else if(part.includes('未确认'))summary.push(count+' 个文件未完成校验')}badge.textContent=[...summary,...copies.map(([id,copy])=>folderCopyText(id,copy,!locations||locations.includes(id)))].join(String.fromCharCode(10));return}badge.textContent=health.detail;return}for(const part of health.detail.split(' · ')){if(part==='Worker 内容基准'||part.startsWith('Plan 归属：'))continue;let text=part;const copy=part.match(/^(本机|[^ ]+) (最新版|同版|缺失|不同版|待更新|冲突|未校验(?:，待核对)?)$/);if(copy){const id=copy[1],version=health.versions?.[id==='本机'?'local':id],role=versionRole(version);const issue=copy[2]==='缺失'||!version&&copy[2]==='待更新'?'缺失':copy[2]==='待更新'||copy[2]==='不同版'?'需同步':copy[2]==='冲突'?'内容冲突':copy[2].startsWith('未校验')?'未校验':'';text=id+(version?' '+versionTime(version):'')+(role?' · '+role:'')+(issue?' · '+issue:'')}else if(part==='内容冲突，无法判定最新版')text='最新版未确定';const item=document.createElement('span');item.textContent=text;badge.appendChild(item)}}
function folderHealth(path){const view=state();if(view.statuses[path])return view.statuses[path];const failed=[...view.refreshErrors.entries()].find(([root])=>root==='.'||path===root||path.startsWith(root+'/'));if(failed)return {state:'unknown',detail:'清单校验失败：'+failed[1]};const checked=[...view.refreshedPaths].find(root=>root==='.'||path===root||path.startsWith(root+'/'));if(checked){const parent=view.statuses[checked];if(parent?.detail?.includes('清单校验失败'))return {state:'unknown',detail:parent.detail};return {state:'unknown',detail:'目录内无可校验文件'}}return {state:'unknown',detail:'尚未读取目录信息'}}
function row(entry,depth){
  const view=state(),el=document.createElement('div');el.className='row';el.style.paddingLeft=(depth*18)+'px';
  if(entry.path==='.'&&view.directoryObservations?.get('.'))entry={...entry,observations:view.directoryObservations.get('.')};
  if(active.id==='local'&&!view.issueFilterOn&&entry.path!=='.'&&selected(entry.path))el.className+=' transfer-scope';
  const toggle=document.createElement('button');toggle.className='twisty';toggle.textContent=entry.directory?(view.expanded.has(entry.path)?'▾':'▸'):' ';toggle.disabled=!entry.directory;
  toggle.onclick=()=>{if(view.expanded.has(entry.path)){view.expanded.delete(entry.path);renderTree()}else{view.expanded.add(entry.path);summaryChildren(view);renderTree();if(!view.issueFilterOn){if(view.indexExpired||indexObservationNeedsRefresh(view))refreshVisible();else{load(entry.path);summarize(active.id)}}}};el.appendChild(toggle);
  const box=document.createElement('input');box.type='checkbox';
  if(view.operationMode){const children=shownChildren('.')||[];box.checked=entry.path==='.'?children.length>0&&children.every(item=>operationSelected(item.path)&&![...view.operationExcluded].some(excluded=>excluded.startsWith(item.path+'/'))):operationSelected(entry.path)&&![...view.operationExcluded].some(item=>item.startsWith(entry.path+'/'));box.indeterminate=!box.checked&&(operationSelected(entry.path)||[...view.operationSelected].some(item=>entry.path==='.'||item.startsWith(entry.path+'/')));box.disabled=entry.path==='.'&&!children.length;box.title='勾选批量同步或删除目标；范围外、同步暂停和仅服务器存在的路径也可选择，不改变自动同步范围'}
  else if(view.issueFilterOn){const total=view.issueTree?.counts.get(entry.path)||0,count=view.issueTree?.checked.get(entry.path)||0;box.checked=total>0&&count===total;box.indeterminate=count>0&&!box.checked;box.disabled=!total}
  else if(entry.path==='.') {const eligible=(view.children.get('.')||[]).filter(item=>item.selectable!==false);const count=eligible.filter(item=>selected(item.path)).length;box.checked=active.excludable?eligible.length>0&&count===eligible.length&&!eligible.some(item=>hasExcludedChild(item.path)):view.selected.has('.');box.indeterminate=active.excludable&&count>0&&!box.checked;box.disabled=entry.selectable===false||active.excludable&&!eligible.length}
  else{box.checked=selected(entry.path)&&!hasExcludedChild(entry.path);box.indeterminate=!box.checked&&childSelected(entry.path);box.disabled=entry.selectable===false||!active.excludable&&[...view.selected].some(item=>item==='.'||item!==entry.path&&entry.path.startsWith(item+'/'))}
  box.disabled=box.disabled||Boolean(view.busyAction);if(!view.operationMode&&!view.issueFilterOn)box.title=entry.selectable===false?'仅服务器存在的路径不能加入本机传输范围；点击“选择操作项”可批量管理':'编辑自动同步范围；批量管理请点击“选择操作项”';box.onchange=()=>view.operationMode?setOperationSelection(entry.path,box.checked):setSelection(entry.path,box.checked);el.appendChild(box);
  const health=entry.directory?folderHealth(entry.path):view.statuses[entry.path]||(active.id==='local'&&!selected(entry.path)?{state:'unknown',detail:'当前同步范围外'}:undefined);
  if(!entry.directory&&health?.metadata)entry={...entry,observations:health.metadata,locations:Object.entries(health.metadata).filter(([,copy])=>copy.status==='present').map(([id])=>id)};
  const label=document.createElement('label');label.className='name '+(health?.state||'unknown');label.textContent=(entry.directory?'📁 ':'📄 ')+entry.name;label.title=entry.path+(health?.state!=='same'&&health?.detail?' · '+health.detail:'');label.onclick=()=>entry.directory&&toggle.click();el.appendChild(label);
  if(!entry.directory&&health?.issueSignature){const filter=document.createElement('button');filter.className='secondary';filter.textContent='筛选同类';filter.title='仅显示缺失位置和内容版本关系相同的异常文件';filter.onclick=()=>{showIssueFilter(view,health.issueSignature);status.textContent='已按 '+entry.path+' 的差异情况筛选'};el.appendChild(filter)}
  const badge=document.createElement('span'),groups=copyGroups(entry,health),compared=health?.copies||health?.versions||health?.basis;badge.className='badge '+(compared?health.state:entry.observations?'unknown':health?.state||'unknown');
  if(health?.state!=='same'){
    if(entry.directory&&health?.basis==='metadata')badge.textContent=health.detail.split(' · ').slice(0,5).join(' · ');
    else if(!entry.directory&&groups.length)badge.textContent=[...(health?.basis==='metadata'&&health.state==='unknown'?[health.detail]:[]),...groups.map(groupText)].join(String.fromCharCode(10));
    else if(compared)paintStatus(badge,health,entry.directory,entry.locations);
    else badge.textContent=entry.directory&&!entry.observations&&health?.detail?health.detail:groups.length?groups.map(groupText).join(String.fromCharCode(10)):health?.detail||'尚未读取文件信息';
  }
  badge.title=[health?.detail,...Object.entries(entry.observations||{}).map(([id,copy])=>observedText(id,copy,true)+(copy.observedAt?' · 读取于 '+copy.observedAt:''))].filter(Boolean).join(String.fromCharCode(10));el.appendChild(badge);
  if(health?.held||entry.held){const mark=document.createElement('span');mark.className='held';mark.textContent='同步暂停';el.appendChild(mark)}
  if(entry.path!=='.'){
    const more=document.createElement('button');more.className='secondary more';more.textContent=view.detailPath===entry.path?'收起':'版本与操作';more.onclick=()=>{view.detailPath=view.detailPath===entry.path?null:entry.path;renderTree()};el.appendChild(more);
    const remove=document.createElement('button');remove.className='secondary row-delete';remove.textContent='一键删除';remove.title='选择删除位置，完整路径两次确认后永久删除'+(entry.directory?'目录及其内容':'文件');remove.disabled=Boolean(view.busyAction);remove.onclick=()=>sendBatch('batchDelete',[entry.path]);el.appendChild(remove);
  }
  if(active.id==='workers'&&entry.directory){const merge=document.createElement('button');merge.className='secondary';merge.textContent='按最新版合并';merge.title='逐文件选取 Plan 最新运行、手动选定或唯一最新时间候选，仅同步到其他 Worker';merge.disabled=Boolean(view.busyAction);merge.onclick=()=>sendAction('mergeLatest',entry);el.appendChild(merge)}
  tree.appendChild(el);
  if(entry.path===view.focus){el.className+=' focus-conflict';if(view.pendingFocusScroll===entry.path){view.pendingFocusScroll=null;view.scrollTarget=el}}
  if(entry.path!=='.'&&view.detailPath===entry.path){
    const actions=document.createElement('div');actions.className='row-detail';actions.style.paddingLeft=(depth*18+48)+'px';
    for(const group of groups){const item=document.createElement('span');item.className='version';item.textContent=groupText(group);item.title=group.ids.map(id=>entry.observations?.[id]?.error||health?.versions?.[id]&&versionRole(health.versions[id])||'').filter(Boolean).join('；');
      for(const id of group.ids){const observed=entry.observations?.[id],v=health?.versions?.[id];if(observed&&observed.status!=='present')continue;
      if(!observed&&!v&&(!entry.directory||!(entry.locations||[]).includes(id)))continue;
      const buttons=group.ids.length>1?document.createElement('span'):item;if(buttons!==item){buttons.textContent=id==='local'?'本机':id;buttons.title=id+'：选择该位置执行操作';item.appendChild(buttons)}
      const actionEntry=observed?{...entry,directory:observed.directory===true}:entry;
      const retain=document.createElement('button');retain.className='secondary';retain.textContent='以此版同步到其他位置';retain.disabled=Boolean(view.busyAction)||(!observed&&((!v&&!entry.directory)||!health||health.state==='unknown'||health.unverified===true));retain.title=observed?'选择此来源，随后显示完整路径并核实实际文件':retain.disabled?'请先完成此路径的内容校验':id==='local'?'同步到所有已启用 Worker 并逐台校验内容':active.id==='workers'?'仅同步到其他 Worker 并逐台校验内容':'同步到其他已启用 Worker 和本机，并逐处校验内容';retain.onclick=()=>sendAction('retain',actionEntry,id);buttons.appendChild(retain);
      const remove=document.createElement('button');remove.className='secondary';remove.textContent='删除';remove.disabled=Boolean(view.busyAction);remove.onclick=()=>sendAction('remove',actionEntry,id);buttons.appendChild(remove)}actions.appendChild(item)}
    const present=entry.locations||[];if(present.some(id=>id!=='local')&&(!present.includes('local')||entry.directory&&health?.copies?.local?.present===0&&health.copies.local.missing>0)){const removeAll=document.createElement('button');removeAll.className='secondary';removeAll.textContent='删除所有 Worker 副本';removeAll.disabled=Boolean(view.busyAction);removeAll.title='本机不会删除；执行前显示每台 Worker 的完整路径并二次确认';removeAll.onclick=()=>sendAction('removeAllWorkers',entry);actions.appendChild(removeAll)}
    tree.appendChild(actions);
  }
  if(entry.directory&&view.expanded.has(entry.path)){const children=shownChildren(entry.path);if(children)children.forEach(child=>row(child,depth+1));else{const wait=document.createElement('div');wait.className='muted';wait.style.paddingLeft=((depth+1)*18)+'px';wait.textContent='读取中…';tree.appendChild(wait)}}
}function renderSelectionControls(view){
  document.getElementById('operationSelection').textContent=view.operationMode?'操作多选（已选 '+view.operationSelected.size+' 项）':'选择操作项';document.getElementById('selectionDetail').textContent=view.operationMode?'勾选用于批量同步、删除；范围外和同步暂停项也可操作。':view.issueFilterOn?'筛选勾选用于批量操作，不改变自动同步范围。':'勾选用于编辑自动同步范围；批量管理请切换“选择操作项”。';document.getElementById('save').disabled=!view.scopeEditing||Boolean(view.busyAction);for(const id of ['batchSync','batchDelete'])document.getElementById(id).disabled=Boolean(view.busyAction)||Boolean(view.scopeEditing);document.getElementById('save').title=view.scopeEditing?'保存自动同步范围':'先点击“编辑同步范围”；操作勾选不会保存到同步范围';
  for(const [id,on] of [['operationSelection',view.operationMode],['editScope',view.scopeEditing]]){const button=document.getElementById(id);button.className=on?'active':'secondary';button.disabled=Boolean(view.busyAction)}
}
function renderTree(){if(!active)return;const view=state(),scrollTop=tree.scrollTop;renderSelectionControls(view);view.issueTree=issueTree(view);view.scrollTarget=null;tree.replaceChildren();row({name:active.label,path:'.',directory:true,selectable:active.rootSelectable!==false},0);document.getElementById('showSame').textContent=view.issueFilterOn||view.hideSame?'显示一致项':'隐藏一致项';renderFilterControls();tree.scrollTop=scrollTop;if(view.scrollTarget){view.scrollTarget.scrollIntoView?.({block:'center'});view.scrollTarget=null}}
function applyScopeSelected(message){const view=views.get(message.rootId);if(!view){pendingScopeSelected=message;return}view.selected=new Set(message.paths||[]);if(active?.id===message.rootId){status.className='';status.textContent=message.message||'默认同步范围已载入';renderTree()}}
function renderTabs(){tabs.replaceChildren();document.getElementById('guide').textContent='默认隐藏信息一致项，查询失败单独显示；相同副本合并展示。隐藏不改变同步范围或勾选。文件夹汇总整个子树，自动校验内容，未变化文件复用哈希。';document.getElementById('filterIssues').textContent='筛选缺失、差异和未知';document.getElementById('scope-legend').hidden=active?.id==='workers';document.getElementById('remote-only-legend').hidden=active?.id==='workers';for(const root of roots){const button=document.createElement('button');button.textContent=root.label;button.className=root.id===active?.id?'active':'secondary';button.onclick=()=>{active=root;detail.textContent=root.detail;renderTabs();renderTree();renderIndexProgress();if(state().indexExpired||indexObservationNeedsRefresh(state())){refreshVisible();return}if(!state().children.has('.')&&!state().listPending.size){load('.');summarize(active.id)}};tabs.appendChild(button)}}
function forgetPath(view,path){
  const inside=value=>value===path||value.startsWith(path+'/');
  if(view.directoryObservations)for(const key of [...view.directoryObservations.keys()])if(inside(key))view.directoryObservations.delete(key);
  for(const key of Object.keys(view.statuses))if(inside(key))delete view.statuses[key];
  for(const [parent,children] of view.children){if(inside(parent))view.children.delete(parent);else view.children.set(parent,children.filter(entry=>!inside(entry.path)))}
  for(const set of [view.selected,view.excluded,view.expanded,view.batchSelected,view.refreshedPaths,view.listPending,view.pending,view.operationSelected,view.operationExcluded])for(const key of [...set])if(inside(key))set.delete(key);
  for(const map of [view.refreshErrors,view.listRequests,view.refreshRequests])for(const key of [...map.keys()])if(inside(key))map.delete(key);
  view.refreshQueue=view.refreshQueue.filter(key=>!inside(key));if(inside(view.detailPath||''))view.detailPath=null;if(inside(view.focus||''))view.focus=null;
}
function reconcileChildren(view,parent,entries,complete=true,observations){
  if(!complete){const present=new Set(entries.map(entry=>entry.path));entries=[...entries,...(view.children.get(parent)||[]).filter(entry=>!present.has(entry.path)).map(entry=>({...entry,locations:[],observations:observations?Object.fromEntries(Object.entries(observations).map(([id,copy])=>[id,copy.status==='unknown'?copy:{status:'not-listed',observedAt:copy.observedAt}])):undefined}))];view.children.set(parent,entries);return}
  const present=new Set(entries.map(entry=>entry.path)),known=new Set([...(view.children.get(parent)||[]).map(entry=>entry.path),...view.selected,...view.batchSelected,...view.operationSelected,...Object.keys(view.statuses)]);
  const prefix=parent==='.'?'':parent+'/';
  for(const path of known){if(!path.startsWith(prefix)||path===parent||path==='.')continue;const child=prefix+path.slice(prefix.length).split('/')[0];if(!present.has(child))forgetPath(view,child)}
  view.children.set(parent,entries);
}
function pumpLists(){for(let index=listQueue.length-1;index>=0;index--){const ticket=listQueue[index];if(views.get(ticket.rootId)?.listRequests.get(ticket.path)!==ticket.id)listQueue.splice(index,1)}while(listRunning.size<2&&listQueue.length){const index=listQueue.findIndex(ticket=>![...listRunning.values()].some(active=>active.rootId===ticket.rootId&&active.path===ticket.path));if(index<0)return;const ticket=listQueue.splice(index,1)[0];listRunning.set(ticket.id,ticket);vscode.postMessage(ticket)}}
function finishList(message){for(const [id,ticket] of listRunning)if(ticket.rootId===message.rootId&&ticket.path===message.path&&(!message.id||message.id===id))listRunning.delete(id);pumpLists()}
function load(path,rootId=active.id){const view=views.get(rootId);if(!view)return;const prior=view.listRequests.get(path);if([...listRunning.values(),...listQueue].some(ticket=>ticket.id===prior))return;const id=String(++serial);view.listPending.add(path);view.listRequests.set(path,id);listQueue.push({type:'list',id,rootId,path,roundId:rootId+'-'+(view.roundId||0)});pumpLists()}
function enqueueRefresh(rootId,paths){const view=views.get(rootId);if(!view)return;for(const path of paths)if(![...view.pending,...view.refreshQueue].some(parent=>parent==='.'||parent===path||path.startsWith(parent+'/')))view.refreshQueue.push(path);pumpRefresh(rootId)}
function summarize(rootId){const view=views.get(rootId),root=roots.find(root=>root.id===rootId);if(!view||!root?.summary||view.pending.size||view.refreshedPaths.has('.'))return;const id=String(++serial);view.pending.add('.');view.refreshRequests.set('.',id);vscode.postMessage({type:'summary',id,rootId,path:'.',roundId:rootId+'-'+(view.roundId||0)})}
function summaryChildren(view){for(const parent of new Set(['.',...view.expanded])){const known=new Map((view.children.get(parent)||[]).map(entry=>[entry.path,entry])),before=known.size;for(const [path,health] of Object.entries(view.statuses)){if(path==='.'||parentPath(path)!==parent||known.has(path)||health.basis!=='metadata')continue;const directory=Boolean(health.copies),observations=directory?Object.fromEntries(Object.entries(health.copies).map(([id,copy])=>[id,{status:copy.present?'present':'unknown',directory:true}])):health.metadata;known.set(path,{name:path.slice(path.lastIndexOf('/')+1),path,directory,selectable:true,observations,locations:Object.entries(observations||{}).filter(([,copy])=>copy.status==='present').map(([id])=>id)})}if(known.size!==before)view.children.set(parent,[...known.values()].sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)))}}
function pumpRefresh(rootId){const view=views.get(rootId);if(!view||view.pending.size||!view.refreshQueue.length)return;const path=view.refreshQueue.shift();view.pending.add(path);if(active?.id===rootId&&!view.busyAction)status.textContent=(view.actionError?'部分路径处理失败：'+view.actionError+'；':'')+'正在校验 '+path+' 的全部文件…';const id=String(++serial);view.refreshRequests.set(path,id);vscode.postMessage({type:'refresh',id,rootId,path})}
function scheduleInvalidatedRefresh(){if(!active)return;const view=state();if(!view.indexExpired||view.invalidationTicket||view.busyAction)return;const ticket={};view.invalidationTicket=ticket;setTimeout(()=>{if(view.invalidationTicket!==ticket)return;view.invalidationTicket=null;if(active&&state()===view&&view.indexExpired&&!view.busyAction)refreshVisible()},200)}
function indexReadText(view,text){return(view.actionError?'部分路径处理失败：'+view.actionError+'；':'')+text}
function beginIndexRefresh(rootId,parents){const view=views.get(rootId);if(!view)return;view.invalidationTicket=null;view.indexExpired=false;view.expiryTicket=null;view.checkedAt=undefined;resetIndexProgress(view);view.roundId=(view.roundId||0)+1;view.listRequests.clear();view.listPending.clear();view.refreshRequests.clear();view.pending.clear();view.refreshQueue=[];view.statuses={};view.refreshedPaths.clear();view.refreshErrors.clear();view.readStage=roots.find(root=>root.id===rootId)?.summary?'正在索引文件…':'正在读取文件列表…';if(active?.id===rootId&&!view.busyAction){status.className='busy';status.textContent=indexReadText(view,view.readStage)}for(const parent of parents)load(parent,rootId);summarize(rootId)}
function refreshVisible(){if(!active)return;vscode.postMessage({type:'cancelRefresh',rootId:active.id,cancelReads:true});beginIndexRefresh(active.id,new Set(['.',...state().expanded]))}
function reloadAfterMutation(message){
  const affected=[...new Set([...(message.affected||[]),...(message.completed||[]),...(message.path?[message.path]:[])])];
  vscode.postMessage({type:'cancelRefresh',rootId:message.rootId,cancelReads:true});
  for(const [rootId,view] of views){
    if(rootId===message.rootId)view.busyAction=null;
    // Old in-flight replies must not restore files removed by this operation, or keep refresh waiting forever.
    const parents=new Set(affected.length?affected.map(path=>path==='.'?'.':parentPath(path)):['.']);
    for(const expanded of view.expanded)if(affected.some(path=>path==='.'||expanded===path||expanded.startsWith(path+'/')))parents.add(expanded);
    for(const key of [...view.children.keys()])if(affected.some(path=>path==='.'||key===path||key.startsWith(path+'/')))view.children.delete(key);
    view.mutationParent=null;view.mutationParents=new Set(parents);
    if(rootId===message.rootId)view.actionError=(message.errors||[]).join('；');
    beginIndexRefresh(rootId,parents);
  }
}
document.getElementById('refresh').onclick=refreshVisible;
document.getElementById('compare').onclick=()=>{if(active){const view=state();view.refreshRequests.clear();view.pending.clear();view.refreshQueue=[];vscode.postMessage({type:'cancelRefresh',rootId:active.id});enqueueRefresh(active.id,['.'])}};
function revealConflict(path){const view=state();view.focus=path;view.pendingFocusScroll=path;let parent=parentPath(path);while(parent!=='.'){view.expanded.add(parent);if(!view.children.has(parent)&&!view.listPending.has(parent)){view.listPending.add(parent);load(parent)}parent=parentPath(parent)}renderTree()}
document.getElementById('nextConflict').onclick=()=>{if(!active)return;const view=state();const all=Object.keys(view.statuses).filter(path=>path!=='.'&&view.statuses[path].state==='different');const paths=all.filter(path=>!all.some(other=>other.startsWith(path+'/'))).sort();if(!paths.length){status.textContent='尚未发现已确认冲突；内容校验自动执行，未核实项请查看状态';return}const index=paths.findIndex(path=>path>String(view.focus||''));const next=paths[index<0?0:index];revealConflict(next);status.textContent='冲突位置：'+next};
document.getElementById('showSame').onclick=()=>{const view=state(),showAll=view.issueFilterOn||view.hideSame;view.hideSame=!showAll;if(showAll){if(view.issueFilterOn){view.operationMode=true;view.scopeEditing=false}view.issueFilterOn=false;view.issueSignature=null}renderTree()};
document.getElementById('filterIssues').onclick=()=>{const view=state();view.batchSelected=new Set();showIssueFilter(view,null);if(!view.issueTree?.files.length)status.textContent='本轮尚未发现缺失、差异或查询未知的文件；未读取的位置不代表一致'};
document.getElementById('clearIssueFilter').onclick=()=>{const view=state();view.issueFilterOn=false;view.operationMode=true;view.scopeEditing=false;view.issueSignature=null;view.hideSame=false;renderTree()};
document.getElementById('selectFiltered').onclick=()=>{const view=state();for(const file of view.issueTree?.files||[])view.batchSelected.add(file);renderTree()};
document.getElementById('unselectFiltered').onclick=()=>{const view=state();for(const file of view.issueTree?.files||[])view.batchSelected.delete(file);renderTree()};
document.getElementById('save').onclick=()=>{if(!active||!state().scopeEditing)return;pauseRefreshes();status.textContent='保存中…';vscode.postMessage({type:'save',id:String(++serial),rootId:active.id,paths:[...state().selected].sort(),excluded:[...state().excluded].sort()})};
function filteredBatchPaths(view){const result=[];for(const folder of [...(view.issueTree?.uniform||[])].sort((a,b)=>a.length-b.length||a.localeCompare(b)))if((view.issueTree?.counts.get(folder)||0)>0&&view.issueTree?.counts.get(folder)===view.issueTree?.checked.get(folder)&&!result.some(parent=>folder.startsWith(parent+'/')))result.push(folder);for(const file of view.issueTree?.files||[])if(view.batchSelected.has(file)&&!result.some(folder=>file.startsWith(folder+'/')))result.push(file);return result.sort()}
function sendBatch(type,exactPaths){if(!active)return;const view=state();if(view.busyAction)return;if(!exactPaths&&!view.operationMode&&!view.issueFilterOn){status.textContent='请点击“选择操作项”后勾选批量操作目标';return}const managing=view.operationMode,paths=exactPaths||(managing?[...view.operationSelected].sort():view.issueFilterOn?filteredBatchPaths(view):[]),excluded=exactPaths?[]:managing?[...view.operationExcluded].sort():[];if(!paths.length){status.textContent='请先勾选要操作的路径';return}pauseRefreshes();const known=new Map();for(const children of view.children.values())for(const entry of children)if(paths.includes(entry.path))known.set(entry.path,entry);if(view.issueFilterOn)for(const children of view.issueTree?.children.values()||[])for(const entry of children)if(paths.includes(entry.path))known.set(entry.path,entry);const entries=[...known.values()].map(entry=>({name:entry.name,path:entry.path,directory:Boolean(entry.directory),locations:entry.locations||[],selectable:entry.selectable!==false}));const id=String(++serial);view.busyAction={type,path:'.',id,sequence:0};status.className='busy';status.textContent='正在核对勾选路径…';renderTree();vscode.postMessage({type,id,rootId:active.id,paths,excluded,entries})}
document.getElementById('batchSync').onclick=()=>sendBatch('batchSync');
document.getElementById('batchDelete').onclick=()=>sendBatch('batchDelete');
function selectOperations(){if(!active)return;const view=state();view.operationMode=true;view.scopeEditing=false;view.issueFilterOn=false;renderTree();status.textContent='操作多选：勾选文件或目录后批量同步、删除；不改变自动同步范围'}
document.getElementById('operationSelection').onclick=selectOperations;
document.getElementById('deleteSelection').onclick=selectOperations;
document.getElementById('editScope').onclick=()=>{if(!active)return;const view=state();view.operationMode=false;view.scopeEditing=true;view.issueFilterOn=false;renderTree();status.textContent='编辑自动同步范围：修改后点击“保存当前范围”'};
window.addEventListener('message',event=>{
  const message=event.data;
  if(message.type==='indexInvalidated'){listQueue.length=0;for(const view of views.values()){view.refreshRequests.clear();view.listRequests.clear();view.pending.clear();view.listPending.clear();view.refreshedPaths.clear();expireIndexView(view)}if(!active||!state().busyAction){status.className='';status.textContent='文件状态已变化，正在自动增量核实：'+message.reason}scheduleInvalidatedRefresh();
  }else if(message.type==='scopeLoading'){
    status.className='busy';status.textContent=message.message||'正在加载同步范围…';
  }else if(message.type==='init'){
    roots=message.roots;status.className='';status.textContent='范围已载入，展开目录后按需读取文件。';
    for(const root of roots)views.set(root.id,{selected:new Set(root.selected),excluded:new Set(),expanded:new Set(['.']),children:new Map(),listPending:new Set(),pending:new Set(),refreshedPaths:new Set(),refreshErrors:new Map(),listRequests:new Map(),refreshRequests:new Map(),refreshQueue:[],mutationParent:null,focus:null,pendingFocusScroll:null,busyAction:null,statuses:{},hideSame:root.summary===true,issueFilterOn:false,issueSignature:null,batchSelected:new Set(),issueTree:null,operationMode:true,scopeEditing:false,operationSelected:new Set(),operationExcluded:new Set(),indexLocations:root.indexLocations||[],indexProgress:new Map((root.indexLocations||[]).map(row=>[row.id,{endpointId:row.id,label:row.label,state:'reading',detail:'等待索引'}]))});
    active=roots[0];renderTabs();renderIndexProgress();detail.textContent=active.detail;renderTree();load('.');summarize(active.id);
    if(pendingScopeSelected){const queued=pendingScopeSelected;pendingScopeSelected=null;applyScopeSelected(queued)}
  }else if(message.type==='scopeSelected'){
    applyScopeSelected(message);
  }else if(message.type==='readCancelled'){
    if(message.requestType==='list')finishList(message);
    const view=views.get(message.rootId);if(!view)return;
    if(message.requestType==='list'&&view.listRequests.get(message.path)===message.id)view.listPending.delete(message.path);
    if(['refresh','summary'].includes(message.requestType)&&view.refreshRequests.get(message.path)===message.id){view.pending.delete(message.path);interruptIndexProgress(view)}
  }else if(message.type==='readProgress'){
    const view=views.get(message.rootId);if(!view||view.refreshRequests.get(message.path)!==message.id||!view.pending.has(message.path)||view.busyAction)return;
    if(message.progress){view.indexProgress.set(message.progress.endpointId,{...message.progress,label:view.indexLocations.find(row=>row.id===message.progress.endpointId)?.label});if(active?.id===message.rootId)renderIndexProgress()}
    view.readStage=message.stage+' · '+message.path;
    if(active?.id===message.rootId){status.className='busy';status.textContent=indexReadText(view,view.readStage)}
  }else if(message.type==='children'){
    finishList(message);
    const view=views.get(message.rootId);if(!view)return;
    if(message.id&&view.listRequests.get(message.path)!==message.id)return;
    view.listPending.delete(message.path);
    const complete=!message.queryErrors?.length;
    view.directoryObservations ||= new Map();if(message.observations)view.directoryObservations.set(message.path,message.observations);
    reconcileChildren(view,message.path,message.entries,complete,message.observations);
    if(complete&&view.statuses[message.path]?.listingError){view.statuses[message.path]={state:'unknown',detail:'目录信息已读取'};if(active?.id===message.rootId&&!view.busyAction&&!view.pending.size){status.className='';status.textContent='目录信息已读取'}}
    if(!complete&&!view.statuses[message.path]?.basis){for(const key of Object.keys(view.statuses))if(key===message.path||message.path==='.'||key.startsWith(message.path+'/'))view.statuses[key]={state:'unknown',detail:'部分服务器清单未核实'};view.statuses[message.path]={state:'unknown',listingError:true,detail:'部分服务器清单未核实：'+message.queryErrors.join('；')};if(active?.id===message.rootId)status.textContent=view.statuses[message.path].detail}
    if(view.mutationParent===message.path||view.mutationParents?.delete(message.path))view.mutationParent=null;
    if(active?.id===message.rootId)renderTree();
    summarize(message.rootId);
  }else if(message.type==='status'){
    const view=views.get(message.rootId);if(!view)return;
    if(message.id&&view.refreshRequests.get(message.path)!==message.id)return;
    if(message.complete!==false){view.pending.delete(message.path);view.refreshRequests.delete(message.path);view.refreshedPaths.add(message.path)}view.refreshErrors.delete(message.path);
    for(const key of Object.keys(view.statuses))if(key===message.path||message.path==='.'||key.startsWith(message.path+'/'))delete view.statuses[key];
    Object.assign(view.statuses,message.statuses||{});
    if(Object.values(message.statuses||{}).some(row=>row.basis==='metadata'))summaryChildren(view);
    if(active?.id===message.rootId){if(!view.busyAction){status.className=message.complete===false?'busy':'';status.textContent=indexReadText(view,message.complete===false?view.readStage||'正在索引文件…':(Object.values(message.statuses||{}).some(row=>row.basis==='metadata')?'上次读取 ':'上次校验 ')+message.path+'：'+message.refreshedAt)}renderTree()}
    if(message.complete!==false){scheduleIndexExpiry(view);pumpRefresh(message.rootId);}
  }else if(message.type==='saved'){
    const view=views.get(message.rootId);if(view){view.refreshRequests.clear();view.pending.clear();view.refreshQueue=[]}
    if(active?.id===message.rootId){status.textContent='范围已保存；点击刷新文件状态可重新读取';renderTree()}
  }else if(message.type==='actionProgress'){
    const view=views.get(message.rootId);if(!view?.busyAction||view.busyAction.id!==message.id||Number(message.sequence)<=view.busyAction.sequence)return;view.busyAction.sequence=Number(message.sequence);
    if(active?.id===message.rootId){status.className='busy';status.textContent=message.stage+' · '+message.path}
  }else if(message.type==='actionCancelled'){
    const view=views.get(message.rootId);if(view)view.busyAction=null;
    if(active?.id===message.rootId){status.className='';status.textContent='操作已取消';renderTree();scheduleInvalidatedRefresh()}
  }else if(message.type==='batchDone'||message.type==='actionDone'){
    reloadAfterMutation(message);
    if(active?.id===message.rootId)renderTree();
  }else if(message.type==='error'){
    if(message.requestType==='list')finishList(message);
    const view=views.get(message.rootId);
    if(view){
      if(message.id&&message.requestType==='list'&&view.listRequests.get(message.path)!==message.id)return;
      if(message.id&&['refresh','summary'].includes(message.requestType)&&view.refreshRequests.get(message.path)!==message.id)return;
      if(['remove','removeAllWorkers','retain','batchSync','batchDelete','mergeLatest'].includes(message.requestType))reloadAfterMutation({...message,errors:[message.message]});
      if(message.requestType==='list'){view.listPending.delete(message.path);const entries=view.children.get(message.path)||[],ids=new Set([...Object.keys(view.directoryObservations?.get(message.path)||{}),...entries.flatMap(entry=>Object.keys(entry.observations||{}))]);if(ids.size){const observations=Object.fromEntries([...ids].map(id=>[id,{status:'unknown',error:message.message}]));view.directoryObservations ||= new Map();view.directoryObservations.set(message.path,observations);view.children.set(message.path,entries.map(entry=>({...entry,locations:[],observations})))}}
      if(['refresh','summary'].includes(message.requestType)){view.pending.delete(message.path);view.refreshErrors.set(message.path,message.message);interruptIndexProgress(view,'查询失败：'+message.message)}
      if(message.requestType==='list'&&view.mutationParent===message.path)view.mutationParent=null;
      if(message.requestType!=='list'||!view.statuses[message.path]?.basis)view.statuses[message.path]={state:'unknown',listingError:message.requestType==='list',detail:'清单校验失败：'+message.message};
    }
    if(active?.id===message.rootId){if(!view?.pending.size||!['remove','removeAllWorkers','retain','batchSync','batchDelete','mergeLatest'].includes(message.requestType)){status.className='';status.textContent='操作失败 '+message.path+'：'+message.message}renderTree()}
    if(['refresh','summary'].includes(message.requestType))pumpRefresh(message.rootId);
  }
});vscode.postMessage({type:'ready'});
</script></body></html>`;
}
