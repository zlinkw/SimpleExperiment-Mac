import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { planComparisonTables, selectedComparisonCandidates, type ComparisonRun, type RunComparison } from "../results/PlanVersionComparison";
import type { OutputRetirementCandidate } from "./PlanOutputRetention";

export type ConfirmationPath = { label: string; path: string };

function htmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function confirmSyncScopePaths(title: string, note: string, paths: ConfirmationPath[], finalLabel: string): Promise<boolean> {
  const panel = vscode.window.createWebviewPanel("simpleExperimentMac.syncScopeConfirmation", title, vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = crypto.randomBytes(16).toString("base64");
  const rows = paths.map(({ label, path }) => `<div class="path"><strong>${htmlText(label)}</strong><code>${htmlText(path)}</code></div>`).join("");
  panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:960px;margin:auto}
h2{font-size:18px;margin:0 0 10px}.note{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}.paths{max-height:55vh;overflow:auto;border:1px solid var(--vscode-panel-border);padding:12px;margin:14px 0}.path{padding:9px 0;border-bottom:1px solid var(--vscode-panel-border)}.path:last-child{border:0}
strong{display:block;margin-bottom:5px}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;user-select:text;font:var(--vscode-editor-font-size) var(--vscode-editor-font-family)}
.actions{display:flex;justify-content:flex-end;gap:10px;position:sticky;bottom:0;background:var(--vscode-editor-background);padding:12px 0}button{font:inherit;border:0;padding:7px 12px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}#stage{color:var(--vscode-editorWarning-foreground);font-weight:bold}
</style></head><body><h2>${htmlText(title)}</h2><p id="stage">第一次确认：逐项核对下方完整路径</p><p class="note">${htmlText(note)}</p><div class="paths">${rows}</div>
<div class="actions"><button id="cancel" class="secondary">取消</button><button id="confirm" data-final="${htmlText(finalLabel)}">确认路径并继续</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();let stage=1;const confirm=document.getElementById('confirm');document.getElementById('cancel').onclick=()=>vscode.postMessage({type:'cancel'});confirm.onclick=()=>vscode.postMessage({type:stage===1?'reviewed':'confirm'});window.addEventListener('message',event=>{if(event.data?.type==='secondStage'){stage=2;document.getElementById('stage').textContent='第二次确认：再次核对完整路径';confirm.textContent=confirm.dataset.final}});</script></body></html>`;
  return new Promise((resolve) => {
    let stage = 1;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    };
    panel.onDidDispose(() => finish(false));
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === "cancel") finish(false);
      else if (message?.type === "reviewed" && stage === 1) {
        stage = 2;
        void panel.webview.postMessage({ type: "secondStage" });
      } else if (message?.type === "confirm" && stage === 2) finish(true);
    });
  });
}

/** Ephemeral review: no Webview state storage, output files, or disk caches. */
export function reviewPlanVersionResults(runs: ComparisonRun[], candidates: OutputRetirementCandidate[],
  load: (run: ComparisonRun, signal: AbortSignal) => Promise<RunComparison>): Promise<OutputRetirementCandidate[] | undefined> {
  const panel = vscode.window.createWebviewPanel("simpleExperimentMac.planVersionReview", "Plan 版本结果审核", vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = crypto.randomBytes(16).toString("base64");
  const abort = new AbortController();
  const results = new Map<string, RunComparison>();
  let loading = false, settled = false, bytes = 0;
  const post = (message: unknown) => { if (!settled) void panel.webview.postMessage(message); };
  return new Promise(resolve => {
    const finish = (selected?: OutputRetirementCandidate[]) => {
      if (settled) return;
      settled = true;
      abort.abort();
      results.clear();
      bytes = 0;
      messages.dispose();
      closed.dispose();
      resolve(selected);
      panel.dispose();
    };
    const closed = panel.onDidDispose(() => finish());
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (settled) return;
      if (message?.type === "cancel") { finish(); return; }
      if (message?.type === "select") {
        try { finish(selectedComparisonCandidates(runs, results, message.runIds, candidates)); }
        catch (error) { post({ type: "error", message: String(error) }); }
        return;
      }
      if (message?.type !== "ready" || loading) return;
      loading = true;
      post({ type: "runs", runs: runs.map(({ authority: _authority, ...run }) => run), tables: planComparisonTables(runs, results) });
      for (const run of runs) {
        if (settled || abort.signal.aborted) break;
        try {
          const result = await load(run, abort.signal);
          if (settled || abort.signal.aborted) break;
          const size = Buffer.byteLength(JSON.stringify(result));
          if (bytes + size > 32 * 1024 * 1024) throw new Error("审核内存达到 32 MiB 上限；该版本保留，请缩小审核范围。");
          bytes += size;
          results.set(run.runId, result);
          post({ type: "result", result, tables: planComparisonTables(runs, results) });
        } catch (error) {
          if (!settled) post({ type: "runError", runId: run.runId, message: String(error) });
        }
      }
      post({ type: "loaded" });
    });
    panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 16px 50px}h1{font-size:20px}h2{font-size:15px;margin:0 0 8px;overflow-wrap:anywhere}p,.meta{color:var(--vscode-descriptionForeground)}.plan{margin:20px 0}.data{overflow:auto;max-height:360px}.plan-data{overflow:auto;max-height:70vh}table{border-collapse:collapse;font-size:12px;white-space:nowrap}th,td{border:1px solid var(--vscode-panel-border);padding:7px 8px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}.plan-table th{white-space:normal;min-width:55px;max-width:170px}.plan-table th.metric{min-width:140px}.run-identity{min-width:145px}.run-identity span{display:block;margin-top:4px;font-family:var(--vscode-editor-font-family);font-size:11px}.run-state{min-width:110px;max-width:170px;white-space:normal;overflow-wrap:anywhere}.detail-cell{max-width:420px}.detail-cell>details{margin:0}.detail-cell .data{max-width:420px}code{font-family:var(--vscode-editor-font-family)}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:10px;position:sticky;bottom:0;background:var(--vscode-editor-background);padding:12px 0}.warning{color:var(--vscode-editorWarning-foreground)}details{margin-top:8px}summary{cursor:pointer}#status{white-space:pre-wrap}
</style></head><body><h1>Plan 版本结果审核</h1><p>每个 Plan 一张表，每次运行一行。正式统计显示均值±标准差，保留四位小数；预览与未核验运行单独标识。结果仅在本页内存展示，关闭后释放。默认保留所有运行；取消勾选已核验旧运行后，仍需两次确认完整路径。</p><div id="runs"></div><p id="status" role="status">正在读取各版本的轻量 wrapper 结果…</p><div class="actions"><button id="cancel">关闭审核</button><button id="continue" disabled>审核未保留运行的完整路径</button></div><script nonce="${nonce}">
const api=acquireVsCodeApi(),root=document.getElementById('runs'),cards=new Map(),groups=new Map();let runs=[],done=false;
function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);return e}
function short(value){const text=String(value);return text.length>20?text.slice(0,8)+'…'+text.slice(-6):text}
function table(view,parent){const wrap=element('div');wrap.className='data';const t=element('table'),head=element('tr');for(const name of view.header)head.append(element('th',name));t.append(head);let count=0;const more=element('button','显示更多行');function page(){for(const row of view.rows.slice(count,count+200)){const tr=element('tr');for(const [index,cell] of row.entries()){const text=String(cell),td=element('td',['运行','代码','配置'].includes(view.header[index])&&text.length>24?text.slice(0,8)+'…'+text.slice(-8):cell);td.title=text;tr.append(td)}t.append(tr)}count=Math.min(view.rows.length,count+200);more.textContent='显示更多行（'+count+'/'+view.rows.length+'）';more.hidden=count===view.rows.length}more.onclick=page;page();wrap.append(t);parent.append(wrap,more)}
function update(){document.getElementById('continue').disabled=!done||!runs.some(r=>!cards.get(r.runId).check.checked&&!cards.get(r.runId).check.disabled)}
function compare(tables){for(const model of tables||[]){const group=groups.get(model.planFile);group.head.replaceChildren();for(const name of ['保留','提交时间 / 运行','代码','配置','job','核验状态'])group.head.append(element('th',name));for(const column of model.columns){const th=element('th',column.label);th.className='metric';group.head.append(th)}group.head.append(element('th','结果与来源'));for(const row of model.rows){const card=cards.get(row.runId);for(const cell of card.metrics)cell.remove();card.metrics=[];for(const value of row.values){const td=element('td',value);card.row.insertBefore(td,card.detailCell);card.metrics.push(td)}}}}
document.getElementById('cancel').onclick=()=>api.postMessage({type:'cancel'});document.getElementById('continue').onclick=()=>api.postMessage({type:'select',runIds:runs.filter(r=>!cards.get(r.runId).check.checked&&!cards.get(r.runId).check.disabled).map(r=>r.runId)});
window.addEventListener('message',event=>{const m=event.data;if(m.type==='runs'){runs=m.runs;for(const run of runs){if(!groups.has(run.planFile)){const section=element('section');section.className='plan';const wrap=element('div');wrap.className='plan-data';const t=element('table'),head=element('tr'),body=element('tbody');t.className='plan-table';t.dataset.plan=run.planFile;t.append(element('thead'),body);t.firstChild.append(head);wrap.append(t);section.append(element('h2',run.planFile),wrap);root.append(section);groups.set(run.planFile,{head,body})}const row=element('tr');row.dataset.runId=run.runId;const label=element('label'),check=element('input');check.type='checkbox';check.checked=true;check.disabled=true;check.onchange=update;check.setAttribute('aria-label','保留 '+run.runId);label.append(check);const keep=element('td');keep.append(label);const identity=element('td',run.enqueuedAt?run.enqueuedAt.replace('T',' ').slice(0,19):'时间未知');identity.className='run-identity';const id=element('span',short(run.runId));id.title=run.runId;identity.append(id);row.append(keep,identity);for(const value of [run.code,run.revision]){const td=element('td'),code=element('code',short(value));code.title=value;td.append(code);row.append(td)}const status=element('td','正在临时重建…');status.className='run-state';const details=element('details'),detailCell=element('td');detailCell.className='detail-cell';details.append(element('summary','查看结果与来源'));detailCell.append(details);row.append(element('td',run.completed+'/'+run.expected),status,detailCell);groups.get(run.planFile).body.append(row);cards.set(run.runId,{check,status,details,row,detailCell,metrics:[]})}compare(m.tables);return}
if(m.type==='result'){const card=cards.get(m.result.runId),run=runs.find(r=>r.runId===m.result.runId);card.status.textContent=m.result.status==='formal'?(run.eligible?'已核验':'已核验 · 保留'):'未完成预览 · 保留';card.status.title=m.result.status==='formal'?'完整运行 · SHA256 与身份已核验':'未完成运行预览，不参与正式版本统计';card.check.disabled=!run.eligible||m.result.status!=='formal';for(const view of m.result.views){const d=element('details');d.append(element('summary',view.title));if(view.header)table(view,d);else d.append(element('pre',view.text));card.details.append(d)}const sources=element('details');sources.append(element('summary','run / attempt / seed / Worker / checkpoint / SHA256 来源'),element('pre',JSON.stringify(m.result.sources,null,2)));card.details.append(sources);compare(m.tables);update();return}
if(m.type==='runError'){const card=cards.get(m.runId);card.status.className='run-state warning';card.status.textContent='未核验 · 保留：'+String(m.message).slice(0,100);card.status.title=m.message;card.details.append(element('pre',m.message));return}if(m.type==='loaded'){done=true;document.getElementById('status').textContent='读取结束。选择保留的运行，或关闭审核释放临时结果。';update()}if(m.type==='error')document.getElementById('status').textContent=m.message});api.postMessage({type:'ready'});
</script></body></html>`;
  });
}
