import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { PlanCleanupHost } from "./PlanCleanupHost";
import { cleanupError, type CleanupPreview } from "../features/PlanCleanup";

export async function openPlanCleanupPanel(host: PlanCleanupHost, planFile: string, initialOperationId = "") {
  const panel = vscode.window.createWebviewPanel("simpleExperiment.planCleanup", "清除 PLAN 及关联产物", vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = randomBytes(16).toString("hex");
  const initialId = /^[a-f0-9]{48}$/.test(initialOperationId) ? initialOperationId : "";
  let preview: CleanupPreview | undefined, operationId = "", working = false;
  // Register the bridge before loading HTML: the Webview may send its initial
  // history request as soon as its script starts.
  const subscription = panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message.type !== "string") return;
    const concurrent = ["cancel", "poll"].includes(message.type);
    const reply = (value: Record<string, unknown>) => panel.webview.postMessage({ ...value, requestId: message.requestId });
    const progress = (value: { message: string }) => { try { void Promise.resolve(reply({ ...value, type: "progress" })).catch(() => undefined); } catch {} };
    if (working && !concurrent) {
      await reply({ type: "error", message: "OPERATION_BUSY：正在预检或处理，请等待当前操作完成。" });
      return;
    }
    if (!concurrent) working = true;
    let response: Record<string, unknown>;
    try {
      if (message.type === "poll") {
        const operation = await host.service.status(String(message.operationId || ""));
        const states = Object.values(operation.targets);
        response = { type: "progress", operationId: operation.id, message: operation.state + " · 已处理 " + states.filter(row => row.state === "completed").length + "/" + states.length };
      } else if (message.type === "history") {
        response = { type: "history", rows: await host.service.list() };
      } else if (message.type === "status") {
        if (!message.operationId) cleanupError("OPERATION_REQUIRED", "请先选择历史清理操作，或点击完整预览。");
        const operation = await host.service.status(String(message.operationId));
        operationId = operation.id; preview = operation.preview;
        response = { type: "operation", operation };
      } else if (message.type === "preview") {
        preview = undefined; operationId = "";
        preview = await host.service.preview({ planFile, action: message.action, verifiedOnly: message.verifiedOnly }, progress);
        response = { type: "preview", preview };
      } else if (message.type === "continue") {
        if (!operationId) cleanupError("OPERATION_REQUIRED", "请先选择历史清理操作。");
        preview = undefined;
        preview = await host.service.continuePreview(operationId, { verifiedOnly: message.verifiedOnly }, progress);
        operationId = ""; response = { type: "preview", preview };
      } else if (message.type === "recheck") {
        if (!operationId) cleanupError("OPERATION_REQUIRED", "请先选择历史清理操作。");
        const operation = await host.service.status(operationId);
        for (const node of operation.preview.scope.nodes.filter(node => node.kind === "remote")) await host.service.recheckNode(node.id);
        response = { type: "operation", operation: await host.service.status(operationId) };
      } else if (message.type === "confirm") {
        if (!preview) cleanupError("CONFIRM_REQUIRED", "请先完成预览并确认精确路径。");
        const operation = await host.service.confirm({ token: preview.token, digest: preview.digest, phase: message.phase, confirm: true,
          exactTargets: preview.rows.filter(row => row.disposition === preview!.action).map(row => row.node.id + ":" + row.absolutePath) });
        preview = operation.preview; operationId = operation.id;
        response = { type: "confirmed", operation };
      } else if (["execute", "resume"].includes(message.type)) {
        if (!operationId) cleanupError("CONFIRM_REQUIRED", "请先完成预览并确认精确路径。");
        response = { type: "operation", operation: await host.execute(operationId) };
      } else if (message.type === "cancel") {
        if (!operationId) cleanupError("OPERATION_REQUIRED", "当前没有可暂停的操作。");
        response = { type: "operation", operation: await host.service.cancel(operationId) };
      } else if (message.type === "restore") {
        if (!operationId) cleanupError("OPERATION_REQUIRED", "请先选择历史清理操作。");
        preview = undefined;
        preview = await host.service.restorePreview(operationId); response = { type: "preview", preview };
      } else {
        cleanupError("INVALID_REQUEST", "不支持的审核操作。");
      }
    } catch (error: any) {
      const code = error.apiData?.code || error.code;
      response = { type: "error", message: (code ? code + "：" : "") + String(error.message || error) };
    } finally {
      if (!concurrent) working = false;
    }
    // Release the request gate before replying: receiving history can send the
    // next preview immediately, even before postMessage itself resolves.
    await reply(response);
  });
  panel.onDidDispose(() => subscription.dispose());
  panel.webview.html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}button,select{margin:4px;padding:6px}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--vscode-panel-border);padding:6px;text-align:left;overflow-wrap:anywhere}code{font-size:11px}summary{cursor:pointer}#status{white-space:pre-wrap}.warning{color:var(--vscode-editorWarning-foreground)}
</style></head><body><h2>清除 PLAN 及关联产物</h2><p>默认移入各安全根 clean_dir，保留恢复证据。活动任务不会自动停止。共享资产和正式/历史结果保留。</p>
<select id="action"><option value="move">移入 clean_dir（可恢复）</option><option value="delete">永久删除（不可恢复，两次完整路径确认）</option></select>
<label><input type="checkbox" id="partial">仅处理已验证节点（结论为部分完成）</label><button id="preview">完整预览</button>
<p><select id="history"><option value="">历史清理操作</option></select><button id="load">查看状态/恢复</button></p><p id="status" role="status"></p><p id="progress" role="status" aria-live="polite"></p><div id="review"></div><button id="confirm" disabled>确认完整路径</button><button id="execute" disabled>执行</button><button id="cancel" disabled>暂停操作</button><button id="recheck" disabled>核查未完成信号</button><button id="continue" disabled>重新预览未完成项</button><button id="resume" disabled>幂等恢复未完成项</button><button id="restore" disabled>预览恢复已移动项</button>
<script nonce="${nonce}">
const api=acquireVsCodeApi();let model=null,operationId='',phase=0,busy=false,executing=false,sequence=0,requestId='',canConfirm=false,canExecute=false,canOperate=false,canContinue=false,canRestore=false,previewMessage='';
const initialOperationId=${JSON.stringify(initialId)};
const get=id=>document.getElementById(id),esc=value=>String(value===undefined?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let startedAt=0,progressText='',progressCount='';
function renderProgress(){get('progress').textContent=(busy?[progressText,progressCount].filter(Boolean).join(' · '):'本次耗时')+(startedAt?' · '+Math.max(0,Math.floor((Date.now()-startedAt)/1000))+' 秒':'')}
function controls(){get('preview').disabled=get('action').disabled=get('partial').disabled=get('history').disabled=busy;get('load').disabled=busy||!get('history').value;get('confirm').disabled=busy||!canConfirm;get('execute').disabled=busy||!canExecute;get('cancel').disabled=!canOperate;get('resume').disabled=busy||!canOperate||phase!==(model?.action==='delete'?2:1);get('recheck').disabled=busy||!canOperate;get('continue').disabled=busy||!canContinue;get('restore').disabled=busy||!canRestore;get('load').title=busy?'正在等待当前操作回执':'请选择已有历史清理操作';get('confirm').title=busy?'正在预检，请等待回执':canConfirm?'核对完整路径后确认':previewMessage||'请先完成预览';get('execute').title=canExecute?'执行已确认的精确目标':'先完成当前预览要求的路径确认';for(const id of ['cancel','recheck','continue','resume','restore'])get(id).title=get(id).disabled?'先选择可处理的历史操作；暂停、核查、续办和恢复均需要已有清理操作':'';}
function invalidate(){model=null;operationId='';phase=0;canConfirm=canExecute=canOperate=canContinue=canRestore=false;controls();}
function send(type,extra){if(busy&&type!=='cancel')return;const id='request-'+(++sequence);if(type==='cancel'&&busy){get('status').textContent='已请求在目标边界暂停，正在等待当前操作回执…';api.postMessage({type,requestId:id});return}requestId=id;busy=true;startedAt=Date.now();progressCount='';if(['preview','continue','restore'].includes(type))invalidate();if(type==='execute'||type==='resume')executing=true;const labels={history:'正在读取历史清理操作…',preview:'正在只读预览和预检全部节点，请稍候…',status:'正在读取操作状态…',continue:'正在重新预览未完成项…',recheck:'正在只读核查未完成信号…',confirm:'正在核验精确路径确认…',execute:'正在处理已确认的精确目标…',resume:'正在重新预检已确认的未完成项…',restore:'正在预览可恢复目标…',cancel:'已请求暂停…'};progressText=labels[type]||'正在处理…';get('status').textContent=progressText;renderProgress();controls();api.postMessage({type,requestId:id,action:get('action').value,verifiedOnly:get('partial').checked,...extra})}
const messages=rows=>[...new Set(rows.map(b=>[b.code,b.nodeId,b.detail].filter(Boolean).join('：')))].join(String.fromCharCode(10));
function show(m){model=m;operationId='';phase=0;const blockers=(m.blockers||[]).filter(b=>!(m.verifiedOnly&&['OFFLINE_NODE','NODE_UNREACHABLE'].includes(b.code))),eligible=m.rows.some(r=>r.disposition===m.action||m.continuationOf&&['absent','completed'].includes(r.disposition));canConfirm=eligible&&!blockers.length;canExecute=canOperate=canContinue=canRestore=false;previewMessage=blockers.length?'预检受阻，尚不能确认或执行。处理以下原因后点击完整预览：'+String.fromCharCode(10)+messages(blockers):!eligible?'没有可确认的独占目标；目标已保留或尚未核实。查看表内保留原因后重新预览。':'只读预览完成。核对每个服务器及精确目标后再确认。';controls();
get('review').innerHTML='<p>'+esc(m.scope?.planFile||'')+' '+esc(m.scope?.planHash||'')+'</p><p class="warning">'+esc(messages(m.blockers||[]))+'</p>'+((m.scope?.notices||[]).length?'<details class="warning"><summary>配置引用未完全核实；相关配置保留（'+m.scope.notices.length+' 项）</summary>'+esc(messages(m.scope.notices))+'</details>':'')+'<table><thead><tr><th>主机 / 端口 / 安全根</th><th>类别 / 精确路径 / 类型 / 大小</th><th>指纹 / 所有权 / 依赖</th><th>处理方式</th></tr></thead><tbody>'+m.rows.map(r=>'<tr><td>'+esc(r.node.id+' '+(r.node.user||'当前本机用户')+'@'+(r.node.host||'本机')+':'+(r.node.port||'')+' '+r.node.root)+'</td><td>'+esc(r.category||'')+'<br>'+esc(r.absolutePath)+'<br>'+esc(r.type+' '+(r.size===undefined?'未核实':r.size+' bytes'))+'<br>目标：'+esc(r.node.root+'/'+r.destination)+'</td><td><code>'+esc(r.fingerprint||'未核实')+'</code><br>'+esc(r.evidence.join('；'))+'<br>'+esc(r.dependencies.join('；'))+'<details><summary>逐文件清单</summary>'+esc(JSON.stringify(r.inventory||[]))+'</details></td><td>'+esc(r.disposition+' '+(r.protectedReason||r.error||''))+'</td></tr>').join('')+'</tbody></table>';get('confirm').textContent=m.action==='delete'?'第一次确认上述精确路径':'确认上述精确路径';}
get('preview').onclick=()=>send('preview');get('confirm').onclick=()=>{if(model&&canConfirm&&!busy)send('confirm',{phase:phase+1})};
get('execute').onclick=()=>send('execute');get('resume').onclick=()=>send('resume');get('cancel').onclick=()=>send('cancel');get('restore').onclick=()=>send('restore');
get('continue').onclick=()=>send('continue');get('recheck').onclick=()=>send('recheck');
get('load').onclick=()=>{if(!get('history').value){get('status').textContent='尚无选中的历史清理操作，请先选择历史操作或点击完整预览。';return}send('status',{operationId:get('history').value})};get('history').onchange=controls;
setInterval(()=>{if(busy)renderProgress();if(executing&&operationId)api.postMessage({type:'poll',operationId,requestId:'poll-'+(++sequence)})},1000);
get('action').onchange=get('partial').onchange=()=>{invalidate();get('status').textContent='选择已变化，请重新完整预览。'};
window.addEventListener('message',event=>{const m=event.data;if(m.type==='progress'){if(!busy||(m.operationId?m.operationId!==operationId:m.requestId&&m.requestId!==requestId))return;progressText=m.message;progressCount=typeof m.total==='number'&&m.total>0?m.completed+'/'+m.total:'';get('status').textContent=m.message;renderProgress();return}if(m.requestId&&m.requestId!==requestId)return;busy=false;renderProgress();if(m.type==='history'){get('history').innerHTML='<option value="">历史清理操作</option>'+m.rows.map(row=>'<option value="'+esc(row.id)+'">'+esc(row.planFile+' '+row.state+' '+row.updatedAt)+'</option>').join('');controls();if(initialOperationId){get('history').value=initialOperationId;send('status',{operationId:initialOperationId})}else send('preview')}else if(m.type==='preview'){show(m.preview);get('status').textContent=previewMessage}else if(m.type==='confirmed'){operationId=m.operation.id;phase=m.operation.preview.confirmations;canOperate=true;canExecute=phase===(model.action==='delete'?2:1);canConfirm=!canExecute;get('confirm').textContent='第二次确认同一批精确路径';get('status').textContent='路径确认 '+phase+' 次；尚未执行。';controls()}else if(m.type==='operation'){executing=false;show(m.operation.preview);operationId=m.operation.id;phase=m.operation.preview.confirmations;const superseded=Boolean(m.operation.continuedBy||m.operation.restoredBy),closed=m.operation.state==='completed';get('status').textContent='操作 '+operationId+'：'+m.operation.state+'；保留/未核实 '+model.rows.filter(r=>['protected','unverified'].includes(r.disposition)).length+' 项；未处理节点：'+m.operation.pendingNodes.join('、')+(superseded?'；已由后续操作处理。':'')+String.fromCharCode(10)+Object.values(m.operation.nodeChecks||{}).map(check=>check.nodeId+' '+check.state+' '+check.targets.map(row=>row.state+' '+(row.code||'')).join('；')).join(String.fromCharCode(10));canOperate=!closed&&!superseded;canContinue=canOperate&&model.action!=='restore';canRestore=model.action==='move'&&!superseded&&(Object.values(m.operation.targets).some(t=>t.state==='completed')||model.rows.some(row=>row.disposition==='completed'));canExecute=canConfirm=false;controls()}else{executing=false;canExecute=canConfirm=false;previewMessage=m.message||'审核操作未完成，请重新预览。';get('status').textContent=previewMessage;controls()}});send('history');
</script></body></html>`;
  return panel;
}
