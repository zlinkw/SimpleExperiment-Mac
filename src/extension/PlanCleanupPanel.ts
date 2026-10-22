import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { PlanCleanupHost } from "./PlanCleanupHost";
import { cleanupError, cleanupJobKey, type CleanupPreview, type CleanupJobSelection } from "../features/PlanCleanup";

export async function openPlanCleanupPanel(host: PlanCleanupHost, planFile: string, initialOperationId = "", job?: CleanupJobSelection) {
  const selection = job && { ...job };
  const title = selection ? "审核并清理失败任务文件" : "审核并清理 PLAN 文件";
  const panel = vscode.window.createWebviewPanel("simpleExperimentMac.planCleanup", title, vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = randomBytes(16).toString("hex");
  const initialId = /^[a-f0-9]{48}$/.test(initialOperationId) ? initialOperationId : "";
  let preview: CleanupPreview | undefined, operationId = "", working = false;
  const assertScope = (operation: { preview: CleanupPreview }) => {
    if (selection && (operation.preview.scope.planFile !== planFile || cleanupJobKey(operation.preview.scope.job) !== cleanupJobKey(selection))) cleanupError("JOB_SCOPE_CHANGED");
  };
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
        assertScope(operation);
        const states = Object.values(operation.targets);
        response = { type: "progress", operationId: operation.id, operation,
          message: operation.state + " · 已处理 " + states.filter(row => row.state === "completed").length + "/" + states.length + (operation.error ? " · " + operation.error : "") };
      } else if (message.type === "history") {
        const rows = await host.service.list();
        response = { type: "history", rows: selection ? rows.filter(row => row.planFile === planFile && cleanupJobKey(row.job) === cleanupJobKey(selection)) : rows };
      } else if (message.type === "status") {
        if (!message.operationId) cleanupError("OPERATION_REQUIRED", "请先选择清理记录，或点击审核文件。");
        const operation = await host.service.status(String(message.operationId));
        assertScope(operation);
        operationId = operation.id; preview = operation.preview;
        response = { type: "operation", operation };
      } else if (message.type === "preview" || message.type === "changeMode") {
        const reuseToken = message.type === "changeMode" ? preview?.token : undefined;
        preview = undefined; operationId = "";
        preview = await host.service.preview({ planFile, action: message.action, verifiedOnly: message.verifiedOnly, job: selection,
          ...(reuseToken ? { reuseToken } : {}),
          ...(message.action === "delete" ? { authorizationMode: "confirmed_paths" as const } : {}) }, progress);
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
      } else if (message.type === "deleteIsolated") {
        if (!operationId) cleanupError("OPERATION_REQUIRED", "请先选择一条隔离待删记录。");
        preview = undefined;
        preview = await host.service.isolatedDeletePreview(operationId, Boolean(message.verifiedOnly));
        operationId = ""; response = { type: "preview", preview };
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
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}button,select{font:inherit;margin:4px;padding:8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--vscode-panel-border);padding:8px;text-align:left;overflow-wrap:anywhere}code{font-size:11px}summary{cursor:pointer}#status{white-space:pre-wrap}.warning{color:var(--vscode-editorWarning-foreground)}.actions{position:sticky;bottom:0;background:var(--vscode-editor-background);padding:8px 0;border-top:1px solid var(--vscode-panel-border)}#execute{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.5}.steps{font-weight:bold}details{margin:8px 0}.path{white-space:pre-wrap;font-weight:bold}
</style></head><body><h2>${title}</h2><p>${selection ? "只处理选中失败任务的输出目录和指标文件，保留 PLAN、配置和其他任务文件。清理完成后回到任务卡片，点击重新排队；本页不会启动任务。" : "只处理当前 PLAN 的独占配置与关联产物。PLAN、共享默认配置、其他 PLAN 引用的配置和共享资产保留。可选择移入 clean_dir 或永久删除；切换方式复用本页路径，确认前会重新核对文件。"}</p>
<p class="steps">1. 审核文件 → 2. 确认完整路径 → 3. 删除或移走文件</p>
<select id="action" aria-label="处理方式"><option value="move">移入 clean_dir 文件夹（可恢复）</option><option value="delete">永久删除（不可恢复，需确认两次）</option></select>
<label><input type="checkbox" id="partial">先处理可连接且审核通过的服务器（其余稍后处理）</label><button id="preview">审核文件</button>
<p><select id="history" aria-label="清理记录"><option value="">选择清理记录</option></select><button id="load">查看这次清理</button></p><p id="status" role="status"></p><p id="progress" role="status" aria-live="polite"></p><div id="review"></div>
<div class="actions"><p id="approvalHelp" role="status"></p><button id="confirm" disabled>第一次确认上述完整路径</button><button id="execute" disabled>删除已确认文件</button><button id="cancel" disabled>暂停后续文件处理</button></div>
<details><summary>刷新、继续清理或恢复文件</summary><button id="recheck" disabled>刷新清理状态</button><button id="continue" disabled>重新审核剩余文件</button><button id="resume" disabled>继续处理剩余文件</button><button id="restore" disabled>审核可恢复文件</button><button id="deleteIso" disabled>永久删除已隔离文件（需两次确认）</button></details>
<script nonce="${nonce}">
const api=acquireVsCodeApi();let model=null,operationId='',phase=0,busy=false,executing=false,sequence=0,requestId='',canConfirm=false,canExecute=false,canOperate=false,canContinue=false,canRestore=false,canResume=false,canDeleteIso=false,previewMessage='';
const initialOperationId=${JSON.stringify(initialId)};let polling=false;
const get=id=>document.getElementById(id),esc=value=>String(value===undefined?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let startedAt=0,progressText='',progressCount='';
function renderProgress(){get('progress').textContent=(busy?[progressText,progressCount].filter(Boolean).join(' · '):'本次耗时')+(startedAt?' · '+Math.max(0,Math.floor((Date.now()-startedAt)/1000))+' 秒':'')}
const actionName=action=>({delete:'永久删除',move:'移走',restore:'恢复',isolate:'隔离'}[action]||'处理');
const stateName=state=>({ready:'待处理',running:'正在处理文件',paused:'已暂停',partial:'尚有文件未完成',completed:'已完成',blocked:'需要重新审核',confirmation_required:'等待确认',settlement_required:'需要刷新确认结果',pending:'尚未处理',executing:'正在处理',protected:'保留',unverified:'尚未核实'}[state]||state);
function controls(){
get('preview').disabled=get('action').disabled=get('partial').disabled=get('history').disabled=busy;get('load').disabled=busy||!get('history').value;
get('confirm').disabled=busy||!canConfirm;get('execute').disabled=busy||!canExecute;get('cancel').disabled=!canOperate||!executing;get('resume').disabled=busy||!canResume;
get('recheck').disabled=busy||!operationId;get('continue').disabled=busy||!canContinue;get('restore').disabled=busy||!canRestore;get('deleteIso').disabled=busy||!canDeleteIso;
get('confirm').textContent=model?.action==='delete'?(phase===0?'第一次确认：我确认所列路径正确、文件未被占用，并同意永久删除':phase===1?'第二次确认：我确认所列路径正确、文件未被占用，并同意永久删除':'已完成两次确认'):'确认上述完整路径';
get('execute').textContent=actionName(model?.action||get('action').value)+'已确认文件';get('resume').textContent='继续'+actionName(model?.action)+'剩余文件';
get('load').title=busy?'正在处理，请稍候':'选择一条清理记录查看';get('confirm').title=busy?'正在审核，请稍候':canConfirm?'核对上方每个服务器和完整路径后确认':previewMessage||'请先审核文件';
get('execute').title=canExecute?'仅处理上方已经确认的文件':previewMessage||'请先审核并确认完整路径';
get('approvalHelp').textContent=busy?'正在检查路径，请稍候。':canExecute?'路径确认已完成，现在可以点击下方按钮。':canConfirm?'下一步：点击下方“'+get('confirm').textContent+'”。':previewMessage||'先点击“审核文件”，读取要删除的完整路径。';
for(const id of ['cancel','recheck','continue','resume','restore','deleteIso'])get(id).title=get(id).disabled?'先查看已有清理操作；已完成的文件不会重复处理':id==='deleteIso'?'仅把已隔离到 clean 区的内容列入永久删除审核，需两次确认，与新任务互不影响':'';
}
function invalidate(){model=null;operationId='';phase=0;executing=false;canConfirm=canExecute=canOperate=canContinue=canRestore=canResume=canDeleteIso=false;previewMessage='选择已变化，请点击“审核文件”重新检查路径。';get('review').innerHTML='';controls();}
function send(type,extra){
if(busy&&type!=='cancel')return;const id='request-'+(++sequence);
if(type==='cancel'&&busy){get('status').textContent='已请求暂停，当前文件处理结束后不再处理下一个文件。';api.postMessage({type,requestId:id});return}
requestId=id;busy=true;startedAt=Date.now();progressCount='';if(['preview','changeMode','continue','restore','deleteIsolated'].includes(type))invalidate();if(type==='execute'||type==='resume')executing=true;
const labels={history:'正在读取清理记录…',preview:'正在读取文件并审核全部服务器…',status:'正在查询实际清理状态…',continue:'正在重新审核剩余文件…',recheck:'正在查询服务器和文件状态…',confirm:'正在核对已确认的完整路径…',execute:'正在'+actionName(model?.action)+'已确认文件…',resume:'正在检查并继续处理剩余文件…',restore:'正在审核可恢复文件…',deleteIsolated:'正在核对已隔离文件，生成永久删除审核…',cancel:'已请求暂停…'};
progressText=type==='changeMode'?'复用本页路径，核对处理方式…':labels[type]||'正在处理…';get('status').textContent=progressText;renderProgress();controls();api.postMessage({type,requestId:id,action:get('action').value,verifiedOnly:get('partial').checked,...extra})}
const messages=rows=>[...new Set(rows.map(b=>[b.code,b.nodeId,b.detail].filter(Boolean).join('：')))].join(String.fromCharCode(10));
function show(m){
model=m;operationId='';phase=Number(m.confirmations)||0;if(['move','delete'].includes(m.action))get('action').value=m.action;get('partial').checked=Boolean(m.verifiedOnly);
const blockers=(m.blockers||[]).filter(b=>!(m.verifiedOnly&&['OFFLINE_NODE','NODE_UNREACHABLE'].includes(b.code))),eligible=m.rows.some(r=>r.disposition===m.action||m.continuationOf&&['absent','completed'].includes(r.disposition));
const expired=typeof m.expiresAt==='number'&&Date.now()>m.expiresAt;
const visibleRows=m.rows.filter(r=>!['absent','completed'].includes(r.disposition)),noFiles=m.rows.length>0&&visibleRows.length===0;
canConfirm=eligible&&!blockers.length&&!expired;canExecute=canOperate=canContinue=canRestore=canResume=canDeleteIso=false;
previewMessage=noFiles&&!blockers.length?'所选文件已不存在，无需清理。':expired?'这次审核已过期。请点击“审核文件”重新审核，再确认路径。':blockers.length?'审核未通过，尚不能确认或处理。处理以下原因后重新审核：'+String.fromCharCode(10)+messages(blockers):!eligible?'没有可处理文件；请查看仍存在文件的保留原因。':'审核完成，尚未改动文件。请核对每个服务器及完整路径，再点击确认。';
get('review').innerHTML='<p>'+esc(m.scope?.planFile||'')+'</p><p class="warning">'+esc(messages(m.blockers||[]))+'</p>'+((m.scope?.notices||[]).length?'<details class="warning"><summary>审核说明与保留文件（'+m.scope.notices.length+' 项）</summary>'+esc(messages(m.scope.notices))+'</details>':'')+'<table><thead><tr><th>服务器</th><th>要处理的完整路径</th><th>处理方式 / 保留原因</th></tr></thead><tbody>'+visibleRows.map(r=>'<tr><td>'+esc(r.node.id)+'<br>'+esc((r.node.user||'当前用户')+'@'+(r.node.host||'本机')+(r.node.port?':'+r.node.port:''))+'<details><summary>允许操作的目录</summary>'+esc(r.node.root)+'</details></td><td><div class="path">'+esc(r.absolutePath)+'</div>'+esc((r.type==='directory'?'文件夹':'文件')+' · '+(r.size===undefined?'大小未核实':r.size+' 字节'))+(m.action==='delete'?'':'<p>移至：'+esc(r.node.root+'/'+r.destination)+'</p>')+(m.action==='delete'&&r.isolationAbsolutePath?'<p>隔离后实际删除：<span class="path">'+esc(r.isolationAbsolutePath)+'</span></p>':'')+(m.action==='delete'&&(r.device!==undefined||r.inode!==undefined)?'<p>device='+esc(r.device)+' · inode='+esc(r.inode)+'</p>':'')+'<details><summary>查看关联依据和文件明细</summary>'+esc(r.category||'')+'<br>'+esc((r.evidence||[]).join('；'))+'<br>'+esc((r.dependencies||[]).join('；'))+'<p>文件校验值：<code>'+esc(r.fingerprint||'未核实')+'</code></p>'+esc(JSON.stringify(r.inventory||[]))+'</details></td><td>'+esc(({delete:'永久删除',move:'移入 clean_dir（可恢复）',restore:'恢复到原位置',isolate:'移入 clean 隔离区（新任务立即可用原路径；永久删除需稍后两次确认）',protected:'保留',unverified:'尚未核实，不处理',absent:'已不存在',completed:'已处理'}[r.disposition]||r.disposition)+' '+(r.protectedReason||r.error||''))+'</td></tr>').join('')+'</tbody></table>';controls();
}
function showOperation(operation){
show({...operation.preview,rows:operation.preview.rows.map(row=>operation.targets?.[row.id]?.state==='completed'?{...row,disposition:'completed'}:row)});operationId=operation.id;
const superseded=Boolean(operation.continuedBy||operation.restoredBy),closed=operation.state==='completed',required=model.action==='delete'?2:1;
const targets=Object.values(operation.targets||{}),started=Boolean(operation.executionRequestedAt)||targets.some(t=>t.state==='executing'||t.state==='completed');
const ready=operation.state==='ready'&&!superseded&&!started,allowed=canConfirm;
canConfirm=ready&&allowed&&phase<required;canExecute=ready&&allowed&&phase===required;
executing=operation.state==='running'&&!superseded;canOperate=!closed&&!superseded;canContinue=canOperate&&!executing&&model.action!=='restore';
canResume=canOperate&&!executing&&!ready&&allowed&&phase===required;canRestore=model.action==='move'&&!superseded&&(targets.some(t=>t.state==='completed')||model.rows.some(row=>row.disposition==='completed'));
canDeleteIso=model.action==='isolate'&&!superseded&&closed&&targets.length>0&&targets.every(t=>t.state==='completed');
const done=targets.filter(t=>t.state==='completed').length;
let text=superseded?'这次清理已交给后续操作处理，请选择后续清理记录。':closed?(model.action==='isolate'?'旧输出已全部确认移入 clean 隔离区，新任务不受影响；如需永久删除，点击下方“永久删除已隔离文件”，仍需两次确认。':'文件处理完成。'):ready?(canExecute?'已确认完整路径，可以点击“'+actionName(model.action)+'已确认文件”。':canConfirm?(phase===0?'请先确认上方完整路径。':'已完成第一次确认，请再次确认同一批完整路径。'):previewMessage):stateName(operation.state)+'；已处理 '+done+'/'+targets.length+' 项。';
if(!superseded&&!closed&&operation.error)text+=String.fromCharCode(10)+operation.error;
if((operation.pendingNodes||[]).length&&!ready)text+=String.fromCharCode(10)+'尚未完成的服务器：'+operation.pendingNodes.join('、');
previewMessage=text;get('status').textContent=text;controls();
}
get('preview').onclick=()=>send('preview');get('confirm').onclick=()=>{if(model&&canConfirm&&!busy)send('confirm',{phase:phase+1})};
get('execute').onclick=()=>{if(canExecute&&!busy)send('execute')};get('resume').onclick=()=>{if(canResume&&!busy)send('resume')};get('cancel').onclick=()=>{if(canOperate)send('cancel')};get('restore').onclick=()=>{if(canRestore&&!busy)send('restore')};get('deleteIso').onclick=()=>{if(canDeleteIso&&!busy)send('deleteIsolated')};
get('continue').onclick=()=>send('continue');get('recheck').onclick=()=>send('recheck');
get('load').onclick=()=>{if(!get('history').value){get('status').textContent='尚无选中的清理记录，请选择一条记录或点击审核文件。';return}send('status',{operationId:get('history').value})};get('history').onchange=controls;
setInterval(()=>{if(busy)renderProgress();if(executing&&operationId&&!polling){polling=true;api.postMessage({type:'poll',operationId,requestId:'poll-'+(++sequence)})}},1500);
function normalizePoll(m){if(!String(m.requestId||'').startsWith('poll-'))return;polling=false;if(m.operationId&&m.operationId!==operationId)return;if(m.operation&&m.operation.id===operationId&&m.operation.preview.scope?.observationMode==='managed_tmux'&&['completed','partial','paused','blocked'].includes(m.operation.state)){m.type='operation';m.requestId=requestId}else if(m.type==='error'){m.requestId=requestId}}
get('action').onchange=get('partial').onchange=()=>send('changeMode');
window.addEventListener('message',event=>{
const m=event.data;normalizePoll(m);
if(m.type==='progress'){if(!busy&&!executing||(m.operationId?m.operationId!==operationId:m.requestId&&m.requestId!==requestId))return;const targets=Object.values(m.operation?.targets||{});progressText=m.operation?stateName(m.operation.state)+' · 已处理 '+targets.filter(t=>t.state==='completed').length+'/'+targets.length+' 项'+(m.operation.error?' · '+m.operation.error:''):m.message;progressCount=typeof m.total==='number'&&m.total>0?m.completed+'/'+m.total:'';get('status').textContent=progressText;renderProgress();return}
if(m.requestId&&m.requestId!==requestId)return;busy=false;renderProgress();
if(m.type==='history'){
get('history').innerHTML='<option value="">选择清理记录</option>'+m.rows.filter(row=>!(row.action==='delete'&&row.state==='completed')).map(row=>'<option value="'+esc(row.id)+'">'+esc(row.planFile+' · '+actionName(row.action)+(row.action==='isolate'?'待删 ':'')+' · '+stateName(row.state)+' · '+row.updatedAt)+'</option>').join('');controls();
if(initialOperationId){get('history').value=initialOperationId;send('status',{operationId:initialOperationId})}else send('preview')
}else if(m.type==='preview'){show(m.preview);get('status').textContent=previewMessage}
else if(m.type==='confirmed'||m.type==='operation'){showOperation(m.operation)}
else{executing=false;canExecute=canConfirm=canResume=false;previewMessage=m.message||'审核未完成，请重新审核文件。';get('status').textContent=previewMessage;controls()}
});send('history');
</script></body></html>`;
  return panel;
}
