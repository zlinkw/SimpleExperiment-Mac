/** Inject outside legacy templates so regular expressions cannot lose an escape layer. */
export function withRunConfirmation(html: string): string {
  const nonce = /<script\s+nonce="([A-Za-z0-9+/=_-]+)"/.exec(html)?.[1];
  if (!nonce) throw new Error("运行确认面板缺少脚本授权。");
  return html.replace("</body>", String.raw`<style>
#planRunConfirm{position:fixed;inset:0;z-index:100000;background:#0009;display:flex;align-items:center;justify-content:center;padding:12px}
#planRunConfirm[hidden]{display:none}#planRunConfirm .dialog{background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-focusBorder);padding:20px;max-width:1000px;width:95%;max-height:90vh;display:flex;flex-direction:column}
#planRunConfirm .paths{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;flex:1;min-height:60px}#planRunConfirm .buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}#planRunConfirm button{padding:8px 12px;cursor:pointer}
</style><div id="planRunConfirm" hidden role="dialog" aria-modal="true" aria-label="确认运行与文件路径"><div class="dialog"><h2></h2><p class="notice"></p><div class="paths" tabindex="0"></div><div class="buttons"></div></div></div>
<script nonce="${nonce}">
(function(){
 const dialog=document.getElementById('planRunConfirm');let active='';
 window.addEventListener('message',function(event){const m=event.data;if(m.type==='planRunConfirmationClosed'){active='';dialog.hidden=true;return;}if(m.type!=='planRunConfirmation')return;
 active=m.requestId;const p=m.payload;dialog.querySelector('h2').textContent=p.title;
 dialog.querySelector('.notice').textContent=p.planFile+' · '+(p.phase===1?'第一次确认：选择本次运行范围。只删除对应清单中的路径；不会保留旧产物版本。':'第二次确认：永久删除不可恢复。完成后自动继续本次运行。');
 const paths=dialog.querySelector('.paths'),buttons=dialog.querySelector('.buttons');paths.textContent='';buttons.textContent='';
 for(const group of p.groups){const heading=document.createElement('h3');heading.textContent=group.label+(group.disabled?'（没有未完成任务）':'');paths.appendChild(heading);
 for(const row of group.targets){const line=document.createElement('p');line.textContent=[row.server+' · '+row.connection,row.path,row.type==='directory'?'整个文件夹':'文件'].join(String.fromCharCode(10));paths.appendChild(line);}
 if(!group.targets.length){const empty=document.createElement('p');empty.textContent='此范围没有需要删除的文件。';paths.appendChild(empty);}
 const button=document.createElement('button');button.textContent=group.label;button.disabled=!!group.disabled;button.onclick=function(){answer(group.value);};buttons.appendChild(button);}
 const cancel=document.createElement('button');cancel.textContent='取消本次运行';cancel.onclick=function(){answer('cancel');};buttons.appendChild(cancel);dialog.hidden=false;cancel.focus();
 });
 function answer(choice){if(!active)return;const id=active;active='';for(const b of dialog.querySelectorAll('button'))b.disabled=true;vscode.postMessage({command:'answerRunConfirmation',requestId:id,choice:choice});}
 dialog.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();answer('cancel');}});
})();
</script></body>`);
}
