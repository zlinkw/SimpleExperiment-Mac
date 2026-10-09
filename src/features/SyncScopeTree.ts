import * as vscode from "vscode";
import * as crypto from "node:crypto";

export type ScopeEntry = { name: string; path: string; directory: boolean; selectable?: boolean; locations?: string[]; held?: boolean };
export type ScopeStatus = { state: "same" | "different" | "remote-only" | "unknown"; detail: string; issueSignature?: string; versions?: Record<string, { sha256: string; modifiedAtMs: number; latest?: "plan" | "local" | "candidate" | "same" | "manual" }>; copies?: Record<string, { modifiedAtMs: number; present: number; missing: number; needsSync: number; conflict: number; unverified: number }>; held?: boolean; unverified?: boolean };
export type ScopeRoot = {
  id: string;
  label: string;
  detail: string;
  selected: string[];
  rootSelectable?: boolean;
  excludable?: boolean;
  list: (relative: string) => Promise<ScopeEntry[]>;
  refresh: (relative: string) => Promise<Record<string, ScopeStatus>>;
  save: (paths: string[], excluded?: string[]) => Promise<void>;
  remove?: (relative: string, endpointId: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  removeAllWorkers?: (relative: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  retain?: (relative: string, endpointId: string, directory: boolean, report?: (stage: string) => void) => Promise<boolean | void>;
  mergeLatest?: (relative: string, report: (stage: string) => void) => Promise<{ completed: string[]; errors: string[] } | false>;
  batch?: (action: "sync" | "delete", selected: string[], excluded: string[], report: (stage: string) => void, knownEntries: ScopeEntry[]) => Promise<{ completed: string[]; errors: string[] } | false>;
};

export function openSyncScopeTree(title: string, roots: ScopeRoot[]): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel("simpleExperiment.syncScopeTree", title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString("base64");
  panel.webview.html = scopeTreeHtml(nonce);
  panel.webview.onDidReceiveMessage(async (message: any) => {
    const id = String(message?.id || "");
    const root = roots.find((item) => item.id === message?.rootId);
    try {
      if (message?.type === "ready") {
        await panel.webview.postMessage({ type: "init", roots: roots.map(({ id, label, detail, selected, rootSelectable, excludable }) => ({ id, label, detail, selected, rootSelectable, excludable })) });
        return;
      }
      if (!root) throw new Error("同步范围目标已失效。");
      if (message.type === "list") {
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("目录路径不安全。");
        await panel.webview.postMessage({ type: "children", id, rootId: root.id, path: relative, entries: await root.list(relative) });
      } else if (message.type === "refresh") {
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === "..")))
          throw new Error("校验目录路径不安全。");
        await panel.webview.postMessage({ type: "status", id, rootId: root.id, path: relative, statuses: await root.refresh(relative), refreshedAt: new Date().toISOString() });
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
        await panel.webview.postMessage({ type: result === false ? "actionCancelled" : "batchDone", id, rootId: root.id,
          completed: result === false ? [] : result.completed, errors: result === false ? [] : result.errors });
      } else if (message.type === "mergeLatest") {
        if (root.id !== "workers" || !root.mergeLatest) throw new Error("仅 Worker ↔ Worker 模式支持按最新版合并。");
        const relative = String(message.path || ".");
        if (relative !== "." && (relative.startsWith("/") || relative.split("/").some((part: string) => !part || part === "." || part === ".."))) throw new Error("合并路径不安全。");
        let sequence = 0;
        const report = (stage: string) => { void panel.webview.postMessage({ type: "actionProgress", id, rootId: root.id, path: relative, stage, sequence: ++sequence }); };
        const result = await root.mergeLatest(relative, report);
        await panel.webview.postMessage({ type: result === false ? "actionCancelled" : "batchDone", id, rootId: root.id,
          completed: result === false ? [] : result.completed, errors: result === false ? [] : result.errors });
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
      await panel.webview.postMessage({ type: "error", id, requestType: message?.type, rootId: root?.id, path: String(message?.path || "."), message: error instanceof Error ? error.message : String(error) });
    }
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
#status{min-height:20px;margin:8px 0;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere}#status.busy::before{content:'◌';display:inline-block;margin-right:7px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#save{margin-top:8px}.badge{margin-left:8px;font-size:12px;white-space:pre-line;overflow-wrap:anywhere;max-width:60%;min-width:0}.badge.same{display:none}.badge span{display:block;white-space:normal;overflow-wrap:anywhere;max-width:100%}.same{color:var(--vscode-testing-iconPassed,#43a047)}.different{color:var(--vscode-testing-iconFailed,#e53935)}.remote-only{color:var(--vscode-editorWarning-foreground,#d9822b)}.unknown{color:var(--vscode-descriptionForeground)}.focus-conflict{outline:1px solid var(--vscode-focusBorder);background:var(--vscode-list-focusBackground)}
</style></head><body><h2>同步范围</h2><div id="guide" class="muted">单击展开；勾选根目录可全选本机文件，再取消产物目录。点击“版本与操作”查看各副本。状态通过刷新按钮更新。</div><div class="muted"><span class="same">绿色：同版</span>　<span id="remote-only-legend" class="remote-only">橙色：仅 Worker 同版</span>　<span class="different">红色：待更新或冲突</span>　<span id="scope-legend" class="scope-legend">浅色圆角背景：本机 ↔ Worker 传输范围</span></div><div id="tabs"></div><div id="detail" class="muted"></div><button id="refresh" class="secondary">刷新同步状态</button> <button id="nextConflict" class="secondary">定位下一个冲突</button><div class="filterbar"><button id="filterIssues" class="secondary">仅显示异常（已校验）</button><button id="clearIssueFilter" class="secondary" hidden>显示全部</button><button id="selectFiltered" class="secondary" hidden>勾选当前结果</button><button id="unselectFiltered" class="secondary" hidden>取消勾选当前结果</button><span id="filterDetail" class="muted"></span></div><div id="tree"></div><div id="status" role="status"></div><button id="save">保存当前范围</button> <button id="batchSync" class="secondary">批量同步勾选项</button> <button id="batchDelete" class="secondary">批量删除勾选项</button>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let roots=[],active=null,serial=0,pendingScopeSelected=null;const views=new Map();
const tabs=document.getElementById('tabs'),tree=document.getElementById('tree'),status=document.getElementById('status'),detail=document.getElementById('detail');
function state(){return views.get(active.id)}
function parentPath(path){const index=path.lastIndexOf('/');return index<0?'.':path.slice(0,index)}
function issueTree(view){
  if(!view.issueFilterOn)return null;
  const files=Object.keys(view.statuses).filter(path=>view.statuses[path]?.issueSignature&&(!view.issueSignature||view.statuses[path].issueSignature===view.issueSignature)).sort();
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
function shownChildren(path){const view=state();return view.issueFilterOn?view.issueTree?.children.get(path)||[]:view.children.get(path)}
function showIssueFilter(view,signature){view.issueFilterOn=true;view.issueSignature=signature;for(const parent of issueTree(view).children.keys())view.expanded.add(parent);renderTree()}
function renderFilterControls(){const view=state(),on=Boolean(view.issueFilterOn),count=view.issueTree?.files.length||0;document.getElementById('filterIssues').hidden=on;document.getElementById('clearIssueFilter').hidden=!on;document.getElementById('selectFiltered').hidden=!on;document.getElementById('unselectFiltered').hidden=!on;document.getElementById('filterDetail').textContent=on?count+' 个异常文件'+(view.issueSignature?'，仅显示同类差异':'，可点文件“筛选同类”')+'；筛选勾选仅用于批量操作':''}
function sendAction(type,entry,endpointId){const view=state();if(view.busyAction)return;const id=String(++serial);view.busyAction={type,path:entry.path,id,sequence:0};status.className='busy';status.textContent='正在准备 '+entry.path+'，请核对确认页中的完整路径…';renderTree();vscode.postMessage({type,id,rootId:active.id,path:entry.path,endpointId,directory:entry.directory})}
function isExcluded(path){return [...state().excluded].some(item=>item===path||path.startsWith(item+'/'))}
function selected(path){if(isExcluded(path))return false;return [...state().selected].some(item=>item==='.'||item===path||path.startsWith(item+'/'))}
function childSelected(path){return [...state().selected].some(item=>path==='.'||item.startsWith(path+'/'))||selected(path)&&[...state().excluded].some(item=>item.startsWith(path+'/'))}
function hasExcludedChild(path){return [...state().excluded].some(item=>item.startsWith(path+'/'))}
function setSelection(path,checked){const view=state();if(view.issueFilterOn){for(const file of view.issueTree?.files||[])if(path==='.'||file===path||file.startsWith(path+'/')){if(checked)view.batchSelected.add(file);else view.batchSelected.delete(file)}renderTree();return}const set=view.selected,excluded=view.excluded;if(path==='.') {set.clear();excluded.clear();if(checked){if(!active.excludable)set.add('.');else for(const item of view.children.get('.')||[])if(item.selectable!==false)set.add(item.path)}}else if(checked){for(const item of [...excluded])if(item===path||item.startsWith(path+'/'))excluded.delete(item);if(!selected(path)){for(const item of [...set])if(item.startsWith(path+'/'))set.delete(item);set.add(path)}}else{for(const item of [...set])if(item===path||item.startsWith(path+'/'))set.delete(item);if([...set].some(item=>item==='.'||path.startsWith(item+'/')))excluded.add(path);else for(const item of [...excluded])if(item===path||item.startsWith(path+'/'))excluded.delete(item)}renderTree()}
function versionTime(version){if(!version?.modifiedAtMs)return '时间未知';const date=new Date(version.modifiedAtMs);if(Number.isNaN(date.getTime()))return '时间未知';const two=value=>String(value).padStart(2,'0');return date.getFullYear()+'-'+two(date.getMonth()+1)+'-'+two(date.getDate())+' '+two(date.getHours())+':'+two(date.getMinutes())+':'+two(date.getSeconds())}
function versionRole(version){return version?.latest==='plan'?'Plan 最新运行':version?.latest==='manual'?'手动选定':version?.latest==='local'?'本机基准':version?.latest==='candidate'?'时间最新候选':version?.latest==='same'?'与其他 Worker 同内容':''}
function folderCopyText(id,copy,present){const name=id==='local'?'本机':id;if(!present)return name+' 全部缺失';const issues=[copy.missing?'缺失 '+copy.missing:'',copy.needsSync?'需同步 '+copy.needsSync:'',copy.conflict?'内容冲突 '+copy.conflict:'',copy.unverified?'未校验 '+copy.unverified:''].filter(Boolean);return name+' '+versionTime(copy)+(issues.length?' · '+issues.join(' · '):'')}
function paintStatus(badge,health,directory,locations){if(!health){badge.textContent='待刷新';return}if(health.state==='same')return;if(directory){const copies=Object.entries(health.copies||{});if(copies.length){const fullMissing=copies.some(([id])=>locations&&!locations.includes(id));const summary=[];if(!fullMissing)for(const part of health.detail.split(' · ')){const count=Number(part.match(/^([0-9]+) /)?.[1]||0);if(!count)continue;if(part.includes('待更新或冲突'))summary.push(count+' 个文件内容不同或缺失');else if(part.includes('仅 Worker 一致'))summary.push(count+' 个文件本机缺失或不同');else if(part.includes('未确认'))summary.push(count+' 个文件未完成校验')}badge.textContent=[...summary,...copies.map(([id,copy])=>folderCopyText(id,copy,!locations||locations.includes(id)))].join(String.fromCharCode(10));return}badge.textContent=health.detail;return}for(const part of health.detail.split(' · ')){if(part==='Worker 内容基准'||part.startsWith('Plan 归属：'))continue;let text=part;const copy=part.match(/^(本机|[^ ]+) (最新版|同版|缺失|不同版|待更新|冲突|未校验(?:，待核对)?)$/);if(copy){const id=copy[1],version=health.versions?.[id==='本机'?'local':id],role=versionRole(version);const issue=copy[2]==='缺失'||!version&&copy[2]==='待更新'?'缺失':copy[2]==='待更新'||copy[2]==='不同版'?'需同步':copy[2]==='冲突'?'内容冲突':copy[2].startsWith('未校验')?'未校验':'';text=id+(version?' '+versionTime(version):'')+(role?' · '+role:'')+(issue?' · '+issue:'')}else if(part==='内容冲突，无法判定最新版')text='最新版未确定';const item=document.createElement('span');item.textContent=text;badge.appendChild(item)}}
function folderHealth(path){const view=state();if(view.statuses[path])return view.statuses[path];if(active.id==='local'&&!selected(path)&&!childSelected(path))return {state:'unknown',detail:'当前同步范围外'};const failed=[...view.refreshErrors.entries()].find(([root])=>root==='.'||path===root||path.startsWith(root+'/'));if(failed)return {state:'unknown',detail:'清单校验失败：'+failed[1]};const checked=[...view.refreshedPaths].find(root=>root==='.'||path===root||path.startsWith(root+'/'));if(checked){const parent=view.statuses[checked];if(parent?.detail?.includes('清单校验失败'))return {state:'unknown',detail:parent.detail};return {state:'unknown',detail:'目录内无可校验文件'}}return {state:'unknown',detail:'待校验'}}
function row(entry,depth){
  const view=state(),el=document.createElement('div');el.className='row';el.style.paddingLeft=(depth*18)+'px';
  if(active.id==='local'&&!view.issueFilterOn&&entry.path!=='.'&&selected(entry.path))el.className+=' transfer-scope';
  const toggle=document.createElement('button');toggle.className='twisty';toggle.textContent=entry.directory?(view.expanded.has(entry.path)?'▾':'▸'):' ';toggle.disabled=!entry.directory;
  toggle.onclick=()=>{if(view.expanded.has(entry.path)){view.expanded.delete(entry.path);renderTree()}else{view.expanded.add(entry.path);renderTree();if(!view.issueFilterOn)load(entry.path)}};el.appendChild(toggle);
  const box=document.createElement('input');box.type='checkbox';
  if(view.issueFilterOn){const total=view.issueTree?.counts.get(entry.path)||0,count=view.issueTree?.checked.get(entry.path)||0;box.checked=total>0&&count===total;box.indeterminate=count>0&&!box.checked;box.disabled=!total}
  else if(entry.path==='.') {const eligible=(view.children.get('.')||[]).filter(item=>item.selectable!==false);const count=eligible.filter(item=>selected(item.path)).length;box.checked=active.excludable?eligible.length>0&&count===eligible.length&&!eligible.some(item=>hasExcludedChild(item.path)):view.selected.has('.');box.indeterminate=active.excludable&&count>0&&!box.checked;box.disabled=entry.selectable===false||active.excludable&&!eligible.length}
  else{box.checked=selected(entry.path)&&!hasExcludedChild(entry.path);box.indeterminate=!box.checked&&childSelected(entry.path);box.disabled=entry.selectable===false||!active.excludable&&[...view.selected].some(item=>item==='.'||item!==entry.path&&entry.path.startsWith(item+'/'))}
  box.onchange=()=>setSelection(entry.path,box.checked);el.appendChild(box);
  const health=entry.directory?folderHealth(entry.path):view.statuses[entry.path]||(active.id==='local'&&!selected(entry.path)?{state:'unknown',detail:'当前同步范围外'}:undefined);
  const label=document.createElement('label');label.className='name '+(health?.state||'unknown');label.textContent=(entry.directory?'📁 ':'📄 ')+entry.name;label.title=entry.path+(health?.state!=='same'&&health?.detail?' · '+health.detail:'');label.onclick=()=>entry.directory&&toggle.click();el.appendChild(label);
  if(!entry.directory&&health?.issueSignature){const filter=document.createElement('button');filter.className='secondary';filter.textContent='筛选同类';filter.title='仅显示缺失位置和内容版本关系相同的异常文件';filter.onclick=()=>{showIssueFilter(view,health.issueSignature);status.textContent='已按 '+entry.path+' 的差异情况筛选'};el.appendChild(filter)}
  const badge=document.createElement('span');badge.className='badge '+(health?.state||'unknown');paintStatus(badge,health,entry.directory,entry.locations);badge.title=badge.textContent||health?.detail||'待刷新';el.appendChild(badge);
  if(health?.held||entry.held){const mark=document.createElement('span');mark.className='held';mark.textContent='同步暂停';el.appendChild(mark)}
  if(entry.path!=='.'){
    const more=document.createElement('button');more.className='secondary more';more.textContent=view.detailPath===entry.path?'收起':'版本与操作';more.onclick=()=>{view.detailPath=view.detailPath===entry.path?null:entry.path;renderTree()};el.appendChild(more);
  }
  if(active.id==='workers'&&entry.directory){const merge=document.createElement('button');merge.className='secondary';merge.textContent='按最新版合并';merge.title='逐文件选取 Plan 最新运行、手动选定或唯一最新时间候选，仅同步到其他 Worker';merge.disabled=Boolean(view.busyAction);merge.onclick=()=>sendAction('mergeLatest',entry);el.appendChild(merge)}
  tree.appendChild(el);
  if(entry.path===view.focus){el.className+=' focus-conflict';if(view.pendingFocusScroll===entry.path){view.pendingFocusScroll=null;view.scrollTarget=el}}
  if(entry.path!=='.'&&view.detailPath===entry.path){
    const actions=document.createElement('div');actions.className='row-detail';actions.style.paddingLeft=(depth*18+48)+'px';
    const locations=entry.directory&&health?.copies?[...new Set([...(entry.locations||[]),...Object.keys(health.copies)])]:entry.locations||Object.keys(health?.versions||{});
    for(const id of locations){const v=health?.versions?.[id],copy=entry.directory?health?.copies?.[id]:null,item=document.createElement('span');item.className='version '+(v?.latest==='candidate'?'candidate':v?.latest?'same':'');if(entry.directory&&copy&&!(entry.locations||[]).includes(id)){item.textContent=(id==='local'?'本机':id)+' · 全部缺失';actions.appendChild(item);continue}item.textContent=id+(copy?' · '+versionTime(copy)+(copy.missing?' · 缺失 '+copy.missing:'')+(copy.needsSync?' · 需同步 '+copy.needsSync:'')+(copy.conflict?' · 内容冲突 '+copy.conflict:'')+(copy.unverified?' · 未校验 '+copy.unverified:''):v?' · '+versionTime(v)+(versionRole(v)?' · '+versionRole(v):''):entry.directory&&health&&health.state!=='unknown'?' · 目录内容已校验':' · 尚未校验');
      const retain=document.createElement('button');retain.className='secondary';retain.textContent='以此版同步到其他位置';retain.disabled=Boolean(view.busyAction)||(!v&&!entry.directory)||!health||health.state==='unknown'||health.unverified===true;retain.title=retain.disabled?'请先完成此路径的内容校验':id==='local'?'同步到所有已启用 Worker 并逐台校验内容':active.id==='workers'?'仅同步到其他 Worker 并逐台校验内容':'同步到其他已启用 Worker 和本机，并逐处校验内容';retain.onclick=()=>sendAction('retain',entry,id);item.appendChild(retain);
      const remove=document.createElement('button');remove.className='secondary';remove.textContent='删除';remove.disabled=Boolean(view.busyAction);remove.onclick=()=>sendAction('remove',entry,id);item.appendChild(remove);actions.appendChild(item)}
    const present=entry.locations||[];if(present.some(id=>id!=='local')&&(!present.includes('local')||entry.directory&&health?.copies?.local?.present===0&&health.copies.local.missing>0)){const removeAll=document.createElement('button');removeAll.className='secondary';removeAll.textContent='删除所有 Worker 副本';removeAll.disabled=Boolean(view.busyAction);removeAll.title='本机不会删除；执行前显示每台 Worker 的完整路径并二次确认';removeAll.onclick=()=>sendAction('removeAllWorkers',entry);actions.appendChild(removeAll)}
    tree.appendChild(actions);
  }
  if(entry.directory&&view.expanded.has(entry.path)){const children=shownChildren(entry.path);if(children)children.forEach(child=>row(child,depth+1));else{const wait=document.createElement('div');wait.className='muted';wait.style.paddingLeft=((depth+1)*18)+'px';wait.textContent='读取中…';tree.appendChild(wait)}}
}function renderTree(){if(!active)return;const view=state(),scrollTop=tree.scrollTop;view.issueTree=issueTree(view);view.scrollTarget=null;tree.replaceChildren();row({name:active.label,path:'.',directory:true,selectable:active.rootSelectable!==false},0);renderFilterControls();tree.scrollTop=scrollTop;if(view.scrollTarget){view.scrollTarget.scrollIntoView?.({block:'center'});view.scrollTarget=null}}
function applyScopeSelected(message){const view=views.get(message.rootId);if(!view){pendingScopeSelected=message;return}view.selected=new Set(message.paths||[]);if(active?.id===message.rootId){status.className='';status.textContent=message.message||'默认同步范围已载入';renderTree()}}
function renderTabs(){tabs.replaceChildren();document.getElementById('guide').textContent=active?.id==='workers'?'单击展开；仅比较和操作 Worker 上的文件。本机文件不会参与本模式的传输。状态通过刷新按钮更新。':'单击展开；勾选根目录可全选本机文件，再取消产物目录。点击“版本与操作”查看各副本。状态通过刷新按钮更新。';document.getElementById('scope-legend').hidden=active?.id==='workers';document.getElementById('remote-only-legend').hidden=active?.id==='workers';for(const root of roots){const button=document.createElement('button');button.textContent=root.label;button.className=root.id===active?.id?'active':'secondary';button.onclick=()=>{active=root;detail.textContent=root.detail;renderTabs();renderTree();if(!state().children.has('.'))load('.')};tabs.appendChild(button)}}
function load(path,rootId=active.id){vscode.postMessage({type:'list',id:String(++serial),rootId,path})}
function enqueueRefresh(rootId,paths){const view=views.get(rootId);if(!view)return;for(const path of paths)if(!view.refreshQueue.includes(path))view.refreshQueue.push(path);pumpRefresh(rootId)}
function pumpRefresh(rootId){const view=views.get(rootId);if(!view||view.pending.size||!view.refreshQueue.length)return;const path=view.refreshQueue.shift();view.pending.add(path);if(active?.id===rootId&&!view.busyAction)status.textContent='正在校验 '+path+' 的全部文件…';vscode.postMessage({type:'refresh',id:String(++serial),rootId,path})}
function refreshVisible(){if(!active)return;enqueueRefresh(active.id,['.'])}
document.getElementById('refresh').onclick=refreshVisible;
function revealConflict(path){const view=state();view.focus=path;view.pendingFocusScroll=path;let parent=parentPath(path);while(parent!=='.'){view.expanded.add(parent);if(!view.children.has(parent)&&!view.listPending.has(parent)){view.listPending.add(parent);load(parent)}parent=parentPath(parent)}renderTree()}
document.getElementById('nextConflict').onclick=()=>{if(!active)return;const view=state();const all=Object.keys(view.statuses).filter(path=>path!=='.'&&view.statuses[path].state==='different');const paths=all.filter(path=>!all.some(other=>other.startsWith(path+'/'))).sort();if(!paths.length){status.textContent='没有已校验的冲突；请点击刷新同步状态';return}const index=paths.findIndex(path=>path>String(view.focus||''));const next=paths[index<0?0:index];revealConflict(next);status.textContent='冲突位置：'+next};
document.getElementById('filterIssues').onclick=()=>{const view=state();view.batchSelected=new Set();showIssueFilter(view,null);if(!view.issueTree?.files.length)status.textContent='没有已校验的异常文件，请点击刷新同步状态'};
document.getElementById('clearIssueFilter').onclick=()=>{const view=state();view.issueFilterOn=false;view.issueSignature=null;renderTree()};
document.getElementById('selectFiltered').onclick=()=>{const view=state();for(const file of view.issueTree?.files||[])view.batchSelected.add(file);renderTree()};
document.getElementById('unselectFiltered').onclick=()=>{const view=state();for(const file of view.issueTree?.files||[])view.batchSelected.delete(file);renderTree()};
document.getElementById('save').onclick=()=>{if(!active)return;status.textContent='保存中…';vscode.postMessage({type:'save',id:String(++serial),rootId:active.id,paths:[...state().selected].sort(),excluded:[...state().excluded].sort()})};
function filteredBatchPaths(view){const result=[];for(const folder of [...(view.issueTree?.uniform||[])].sort((a,b)=>a.length-b.length||a.localeCompare(b)))if((view.issueTree?.counts.get(folder)||0)>0&&view.issueTree?.counts.get(folder)===view.issueTree?.checked.get(folder)&&!result.some(parent=>folder.startsWith(parent+'/')))result.push(folder);for(const file of view.issueTree?.files||[])if(view.batchSelected.has(file)&&!result.some(folder=>file.startsWith(folder+'/')))result.push(file);return result.sort()}
function sendBatch(type){if(!active)return;const view=state();if(view.busyAction)return;const paths=view.issueFilterOn?filteredBatchPaths(view):[...view.selected].sort(),excluded=view.issueFilterOn?[]:[...view.excluded].sort();if(!paths.length){status.textContent='请先勾选要操作的路径';return}const known=new Map();for(const children of view.children.values())for(const entry of children)if(paths.includes(entry.path))known.set(entry.path,entry);if(view.issueFilterOn)for(const children of view.issueTree?.children.values()||[])for(const entry of children)if(paths.includes(entry.path))known.set(entry.path,entry);const entries=[...known.values()].map(entry=>({name:entry.name,path:entry.path,directory:Boolean(entry.directory),locations:entry.locations||[],selectable:entry.selectable!==false}));const id=String(++serial);view.busyAction={type,path:'.',id,sequence:0};status.className='busy';status.textContent='正在核对勾选路径…';renderTree();vscode.postMessage({type,id,rootId:active.id,paths,excluded,entries})}
document.getElementById('batchSync').onclick=()=>sendBatch('batchSync');
document.getElementById('batchDelete').onclick=()=>sendBatch('batchDelete');
window.addEventListener('message',event=>{
  const message=event.data;
  if(message.type==='scopeLoading'){
    status.className='busy';status.textContent=message.message||'正在加载同步范围…';
  }else if(message.type==='init'){
    roots=message.roots;status.className='';status.textContent='范围已载入，展开目录后按需读取文件。';
    for(const root of roots)views.set(root.id,{selected:new Set(root.selected),excluded:new Set(),expanded:new Set(['.']),children:new Map(),listPending:new Set(),pending:new Set(),refreshedPaths:new Set(),refreshErrors:new Map(),refreshQueue:[],mutationParent:null,focus:null,pendingFocusScroll:null,busyAction:null,statuses:{},issueFilterOn:false,issueSignature:null,batchSelected:new Set(),issueTree:null});
    active=roots[0];renderTabs();detail.textContent=active.detail;renderTree();load('.');
    if(pendingScopeSelected){const queued=pendingScopeSelected;pendingScopeSelected=null;applyScopeSelected(queued)}
  }else if(message.type==='scopeSelected'){
    applyScopeSelected(message);
  }else if(message.type==='children'){
    const view=views.get(message.rootId);if(!view)return;
    view.listPending.delete(message.path);
    view.children.set(message.path,message.entries);
    if(view.mutationParent===message.path){view.mutationParent=null;enqueueRefresh(message.rootId,[message.path])}
    if(active?.id===message.rootId)renderTree();
  }else if(message.type==='status'){
    const view=views.get(message.rootId);if(!view)return;
    view.pending.delete(message.path);
    view.refreshedPaths.add(message.path);view.refreshErrors.delete(message.path);
    for(const key of Object.keys(view.statuses))if(key===message.path||message.path==='.'||key.startsWith(message.path+'/'))delete view.statuses[key];
    Object.assign(view.statuses,message.statuses||{});
    if(active?.id===message.rootId){if(!view.busyAction){status.className='';status.textContent='已校验 '+message.path+'：'+message.refreshedAt}renderTree()}
    pumpRefresh(message.rootId);
  }else if(message.type==='saved'){
    const view=views.get(message.rootId);if(view){view.statuses={};view.refreshedPaths.clear();view.refreshErrors.clear();view.refreshQueue=[]}
    if(active?.id===message.rootId){status.textContent='已保存，请点击刷新同步状态';renderTree()}
  }else if(message.type==='actionProgress'){
    const view=views.get(message.rootId);if(!view?.busyAction||view.busyAction.id!==message.id||Number(message.sequence)<=view.busyAction.sequence)return;view.busyAction.sequence=Number(message.sequence);
    if(active?.id===message.rootId){status.className='busy';status.textContent=message.stage+' · '+message.path}
  }else if(message.type==='actionCancelled'){
    const view=views.get(message.rootId);if(view)view.busyAction=null;
    if(active?.id===message.rootId){status.className='';status.textContent='操作已取消';renderTree()}
  }else if(message.type==='batchDone'){
    const reload=new Set();for(const [rootId,view] of views){if(rootId===message.rootId)view.busyAction=null;for(const path of message.completed||[]){for(const key of Object.keys(view.statuses))if(key===path||key.startsWith(path+'/'))delete view.statuses[key];let parent=parentPath(path);view.children.delete(parent);if(rootId===active?.id&&view.expanded.has(parent))reload.add(parent);for(;;){view.statuses[parent]={state:'unknown',detail:'目录内容已变化，点击刷新同步状态'};if(parent==='.')break;parent=parentPath(parent)}}}
    if(active?.id===message.rootId){status.className='';status.textContent='完成 '+(message.completed||[]).length+' 项'+((message.errors||[]).length?'；失败 '+message.errors.length+' 项：'+message.errors.join('；'):'')+'。点击刷新同步状态查看最新版本';renderTree()}
    for(const parent of reload)load(parent,active.id);
  }else if(message.type==='actionDone'){
    const operated=views.get(message.rootId);if(operated)operated.busyAction=null;
    const parent=parentPath(message.path);
    for(const [rootId,view] of views){
      for(const key of Object.keys(view.statuses))if(key===message.path||key.startsWith(message.path+'/'))delete view.statuses[key];
      let ancestor=parent;
      for(;;){view.statuses[ancestor]={state:'unknown',detail:'目录内容已变化，点击刷新同步状态'};if(ancestor==='.')break;ancestor=parentPath(ancestor)}
      if(message.directory){
        for(const path of [...view.children.keys()])if(path===message.path||path.startsWith(message.path+'/'))view.children.delete(path);
      }
      if(rootId!==message.rootId)continue;
      view.children.delete(parent);view.mutationParent=parent;
      if(message.directory)for(const path of [...view.expanded])if(path===message.path||path.startsWith(message.path+'/'))load(path,rootId);
    }
    if(active?.id===message.rootId){status.className='busy';status.textContent='正在更新 '+parent+'…';renderTree()}
    load(parent,message.rootId);
  }else if(message.type==='error'){
    const view=views.get(message.rootId);
    if(view){
      if(['remove','removeAllWorkers','retain','batchSync','batchDelete','mergeLatest'].includes(message.requestType))view.busyAction=null;
      if(message.requestType==='list')view.listPending.delete(message.path);
      if(message.requestType==='refresh'){view.pending.delete(message.path);view.refreshErrors.set(message.path,message.message)}
      if(message.requestType==='list'&&view.mutationParent===message.path){view.mutationParent=null;enqueueRefresh(message.rootId,[message.path])}
      view.statuses[message.path]={state:'unknown',detail:'清单校验失败：'+message.message};
    }
    if(active?.id===message.rootId){status.className='';status.textContent='操作失败 '+message.path+'：'+message.message;renderTree()}
    if(message.requestType==='refresh')pumpRefresh(message.rootId);
  }
});vscode.postMessage({type:'ready'});
</script></body></html>`;
}
