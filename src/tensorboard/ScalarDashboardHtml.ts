import { scalarChartMathScript } from "./ScalarChartMath";

export const scalarDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SimpleExperiment 实验曲线</title>
<style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#172033;background:#f3f6fa}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}
header{height:58px;display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #dce3ed}h1{font-size:17px;margin:0 12px 0 0}button,input{font:inherit}button{border:1px solid #ccd6e4;background:#fff;border-radius:6px;padding:6px 10px;cursor:pointer}button:hover{background:#eef3fa}button.active{background:#4d68e8;color:#fff;border-color:#4d68e8}.spacer{flex:1}.status{font-size:12px;color:#64748b;max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.error{color:#be2635}
main{display:grid;grid-template-columns:var(--sidebar-width,310px) 6px minmax(0,1fr);height:calc(100vh - 58px)}aside{min-width:0;overflow:auto;background:#fff;padding:14px 12px}.sidebar-handle{cursor:col-resize;background:#e3e9f2;touch-action:none}.sidebar-handle:hover,.sidebar-handle.dragging{background:#91a6d8}.content{overflow:auto;padding:14px}.sidebar-help{margin:0 0 12px;line-height:1.45}.sidebar-tools{position:sticky;top:-14px;z-index:2;background:#fff;padding:6px 0 10px;border-bottom:1px solid #e4eaf2}.sidebar-tools input[type=search]{width:100%;min-height:38px;padding:7px 9px;border:1px solid #cbd6e6;border-radius:7px}.sidebar-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.sidebar-actions label{display:flex;align-items:center;gap:5px;min-height:32px;cursor:pointer}.sidebar-actions input{width:18px;height:18px}.sidebar-actions button{font-size:12px}.selection-summary{margin-top:5px}.tree details{margin:8px 0}.tree summary{cursor:pointer;font-weight:650;padding:7px 3px;border-radius:5px;overflow-wrap:anywhere}.tree summary:hover{background:#edf2fa}.plan-path{display:block;font-size:11px;font-weight:400;color:#64748b;margin:3px 0 0 18px;overflow-wrap:anywhere}.case-row{display:flex;align-items:stretch;gap:6px;margin:6px 0 6px 10px}.case-main{min-width:0;flex:1;text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:8px 10px;overflow-wrap:anywhere}.case-row.is-active .case-main{border-color:#536de3;background:#eef2ff;color:#193c9f}.case-name{font-size:13px;font-weight:600;line-height:1.3}.case-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.case-seed,.case-role{font-size:11px;border-radius:9px;background:#eef2f7;color:#536174;padding:2px 6px}.case-role{background:#dce6ff;color:#274bc3}.compare-toggle{flex:0 0 84px;font-size:12px;padding:5px;line-height:1.3}.compare-toggle.is-selected{background:#e7f6ed;color:#087049;border-color:#80cda2}.compare-toggle:disabled{cursor:default;color:#718096;background:#f2f5f9}.muted{font-size:12px;color:#64748b}.count{font-size:11px;color:#64748b}.empty{padding:22px;background:#fff;border:1px solid #dce3ed;border-radius:8px}
.group{margin:0 0 15px}.group>summary{font-weight:700;font-size:15px;padding:7px 2px;cursor:pointer}.chart-grid{display:grid;grid-template-columns:repeat(var(--chart-columns,3),minmax(0,1fr));gap:12px}.chart-card{min-width:0;background:#fff;border:1px solid #dce3ed;border-radius:8px;padding:0 11px 11px}.chart-card.full-row{grid-column:1/-1}.chart-card>summary{cursor:pointer;font-weight:700;padding:11px 2px;overflow-wrap:anywhere}.chart-card .toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:8px;font-size:12px}.chart-card .toolbar label{display:inline-flex;align-items:center;gap:3px}.chart-card .toolbar input[type=range]{width:75px}.chart-card .toolbar .layout-button{margin-left:auto;font-size:12px;padding:3px 8px}.chart-card canvas{display:block;width:100%;height:clamp(190px,28vh,295px)}.legend{display:flex;flex-wrap:wrap;gap:5px;min-height:22px}.pill{font-size:11px;border-radius:12px;background:#edf1f7;padding:2px 6px}.tooltip{container-type:inline-size;min-width:0;min-height:24px;color:#334155}.hover-hint{font-size:11px;padding:5px 0;color:#64748b}.hover-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:clamp(10px,calc(8px + .55cqw),12px);font-variant-numeric:tabular-nums}.hover-table th,.hover-table td{height:18px;padding:1px 4px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;border-bottom:1px solid #e5eaf2}.hover-table th{color:#64748b;font-weight:600;background:#f3f6fb}.hover-table th:first-child,.hover-table td:first-child{text-align:left}.hover-table col.case-column{width:var(--hover-case-width,14ch)}.hover-table col.step-column{width:var(--hover-step-width,6ch)}.hover-table col.seed-value-column{width:var(--hover-seed-width,12ch)}.hover-table td:first-child{border-left:3px solid var(--series-color);font-weight:600;padding-left:5px}.hover-table tbody tr:nth-child(even){background:#f8faff}.hover-table tbody tr:hover{background:#edf3ff}.hover-table th.seed-value-column,.hover-table td.seed-value-column{padding-left:10px;padding-right:10px;border-left:1px solid #dce5f5}.hover-table th.seed-value-column{font-weight:800;color:#2452a6;background:#eaf0ff}@container (max-width:850px){.hover-table .seed-value-column{display:none}}@container (max-width:570px){.hover-table .extra-column{display:none}}.native{display:block;width:100%;height:calc(100vh - 59px);border:0;background:#fff}
#settings{display:none;position:absolute;right:14px;top:54px;background:#fff;border:1px solid #ccd6e4;box-shadow:0 8px 24px #1b29442b;padding:14px;border-radius:8px;z-index:4}#settings.open{display:block}#settings label{display:block;margin:5px 0}@media(max-width:760px){main{grid-template-columns:1fr}.sidebar-handle{display:none}aside{max-height:31vh;border-right:0;border-bottom:1px solid #dce3ed}.content{height:calc(69vh - 58px)}header{gap:5px;padding:6px}header h1{font-size:14px;margin-right:1px}header button{font-size:12px;padding:5px}}
</style></head><body>
<header><h1>实验曲线</h1><button id="scalarTab" class="active">标量</button><button id="nativeTab">图像 · 直方图 · 网络图</button><span class="spacer"></span><span id="status" class="status"></span><button id="refresh">⟳ 刷新</button><button id="settingsButton">⚙ 设置</button></header>
<div id="settings"><strong>页面设置</strong><label>每行曲线 <input id="columns" type="number" min="1" max="6" step="1" value="3" style="width:65px"> 个</label><p class="muted">窗口较窄时自动减少列数；单张图可切换为单行显示。</p><hr><label><input id="autoRefresh" type="checkbox" checked> 自动刷新</label><label>间隔 <input id="interval" type="number" min="1" step="1" value="5" style="width:65px"> 秒</label><label><input id="band" type="checkbox"> 均值 ± 样本标准差</label><label><input id="raw" type="checkbox"> 显示 seed 原始曲线</label><p class="muted">粗实线是平滑均值；启用平滑时，细虚线是原始均值。阴影始终围绕原始均值绘制标准差，单 seed 或缺失的 step 不画阴影。极值始终从原始记录计算。</p></div>
<main id="scalarPage"><aside><p class="muted sidebar-help">点击 case 显示全部指标；用“加入对比”叠加其他 case 的均值。</p><div class="sidebar-tools"><input id="caseSearch" type="search" placeholder="搜索 Plan 或 case" aria-label="搜索 Plan 或 case"><div class="sidebar-actions"><label><input id="selectedOnly" type="checkbox">仅看已选</label><button id="clearComparisons" type="button">清空对比</button></div><div id="selectionSummary" class="muted selection-summary">尚未选择主图</div></div><div id="tree" class="tree"></div></aside><div id="sidebarHandle" class="sidebar-handle" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin="260" aria-valuemax="600" tabindex="0"></div><div id="content" class="content"><div id="heading" class="empty">从左侧选择一个 case。</div><div id="groups"></div></div></main>
<div id="nativePage" hidden><iframe id="nativeFrame" class="native" title="TensorBoard 图像、直方图和网络图"></iframe></div>
<script>
(function(){
  const server=__SCALAR_VIEWER_SERVER__;
  ${scalarChartMathScript}
  const tree=document.getElementById('tree'),content=document.getElementById('content'),groupRoot=document.getElementById('groups'),status=document.getElementById('status');
  const scalarPage=document.getElementById('scalarPage'),sidebarHandle=document.getElementById('sidebarHandle'),caseSearch=document.getElementById('caseSearch'),selectedOnly=document.getElementById('selectedOnly'),selectionSummary=document.getElementById('selectionSummary');
  const palette=['#3766df','#d97706','#0a9b71','#bb3ba8','#d23d48','#6355c8','#087eaa','#a06328','#5b8f25','#e56b9f','#137c6b','#b05b16','#7b4fc4','#ba7f12','#d8508b','#4c879e','#8f581c','#4f8b60','#bc6f64','#5762a0'];
  const maxComparisonCases=19;
  const interval=document.getElementById('interval'),columns=document.getElementById('columns'),auto=document.getElementById('autoRefresh'),band=document.getElementById('band'),raw=document.getElementById('raw');
  let catalog=[],catalogReady=false,catalogLoading=false,active=null,comparison=new Map(),cards=new Map(),observer=null,generation=0,refreshing=false,pending=false,lastRequest=0,backoff=0,nativeStarted=false,nativeOpening=false,localEpoch=__SCALAR_VIEWER_EPOCH__,nextNativeAttempt=0,seriesRequestKey='',autoRefreshTimer=0,connectionTimer=0,connectionChecking=false,connectionController=null;
  const readControllers=new Map();
  const planOpen=new Map();
  interval.value=String(Math.max(1,Number(localStorage.getItem('scalarInterval')||5)));auto.checked=localStorage.getItem('scalarAuto')!=='false';
  band.checked=localStorage.getItem('scalarBand')==='true';raw.checked=localStorage.getItem('scalarRaw')==='true';
  columns.value=String(Math.max(1,Math.min(6,Math.floor(Number(localStorage.getItem('scalarColumns'))||3))));
  function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node}
  function key(value){return value.planFile+'|'+value.case}
  function setSidebarWidth(value,persist){const maximum=Math.min(600,Math.max(260,window.innerWidth-380)),width=Math.max(260,Math.min(maximum,Math.round(Number(value)||310)));scalarPage.style.setProperty('--sidebar-width',width+'px');sidebarHandle.setAttribute('aria-valuenow',String(width));if(persist)localStorage.setItem('scalarSidebarWidth',String(width))}
  setSidebarWidth(localStorage.getItem('scalarSidebarWidth'),false);
  function fullRowKey(tag){return 'scalarFullRow:'+encodeURIComponent(key(active))+'|'+encodeURIComponent(tag)}
  function applyChartLayout(){const requested=Math.max(1,Math.min(6,Math.floor(Number(columns.value)||3)));const available=Math.max(1,Math.floor(groupRoot.clientWidth/300));groupRoot.style.setProperty('--chart-columns',String(Math.min(requested,available)));requestAnimationFrame(()=>cards.forEach(drawCard))}
  function message(value,isError){status.textContent=value;status.className=isError?'status error':'status'}
  function cancelRead(action){const controller=readControllers.get(action);if(!controller)return;readControllers.delete(action);controller.abort()}
  function cancelScalarReads(){['catalog','tags','series'].forEach(cancelRead)}
  async function call(action,extra){
    const controller=new AbortController();
    cancelRead(action);readControllers.set(action,controller);
    try{
      const response=await fetch('/tensorboard/api?server='+encodeURIComponent(server),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action},extra||{})),signal:controller.signal});
      const data=await response.json();
      if(!response.ok||data.error){const error=new Error(data.error||'HTTP '+response.status);error.retryAfterMs=data.retryAfterMs||1000;throw error}
      return data;
    }finally{if(readControllers.get(action)===controller)readControllers.delete(action)}
  }
  function mergeCatalog(data){const plans=new Map();(data.plans||[]).forEach(plan=>{let existing=plans.get(plan.planFile);if(!existing){existing={planFile:plan.planFile,suite:plan.suite,cases:new Map()};plans.set(plan.planFile,existing)}(plan.cases||[]).forEach(item=>{let row=existing.cases.get(item.case);if(!row){row={planFile:plan.planFile,case:item.case,expectedSeeds:0};existing.cases.set(item.case,row)}row.expectedSeeds=Math.max(row.expectedSeeds,item.expectedSeeds||0)})});return [...plans.values()]}
  function renderTree(){
    const query=caseSearch.value.trim().toLowerCase(),only=selectedOnly.checked;
    tree.replaceChildren();let shown=0;
    catalog.forEach((plan,index)=>{
      const planLabel=plan.planFile==='__unassigned__'?'未归属':plan.planFile;
      const planMatch=(plan.suite+' '+planLabel).toLowerCase().includes(query);
      const items=[...plan.cases.values()].filter(item=>(!only||(active&&key(item)===key(active))||comparison.has(key(item)))&&(!query||planMatch||item.case.toLowerCase().includes(query)));
      if(!items.length)return;
      shown+=items.length;
      const details=el('details');details.open=query||only?true:(planOpen.has(plan.planFile)?planOpen.get(plan.planFile):index===0);
      details.ontoggle=()=>planOpen.set(plan.planFile,details.open);
      const title=el('summary');title.appendChild(el('span','',plan.suite+' · '+items.length+' case'));title.appendChild(el('span','plan-path',planLabel));details.appendChild(title);tree.appendChild(details);
      items.forEach(item=>{
        const itemKey=key(item),isActive=!!active&&itemKey===key(active),isCompared=comparison.has(itemKey);
        const row=el('div','case-row'+(isActive?' is-active':''));
        const main=el('button','case-main');main.type='button';main.dataset.caseKey=itemKey;main.title='设为主图，显示该 case 的全部指标';
        main.appendChild(el('span','case-name',item.case));
        const meta=el('span','case-meta');meta.appendChild(el('span','case-seed',item.expectedSeeds?item.expectedSeeds+' seeds':'历史日志'));if(isActive)meta.appendChild(el('span','case-role','主图'));main.appendChild(meta);
        main.onclick=()=>void selectCase(item);
        const compare=el('button','compare-toggle'+(isCompared?' is-selected':''),isActive?'主图中':isCompared?'移出对比':'+ 加入对比');
        compare.type='button';compare.disabled=isActive||!active;compare.setAttribute('aria-pressed',String(isCompared));compare.title=isActive?'当前主图自动显示':!active?'先选择一个主图':'叠加或移除该 case 的同名指标均值';
        compare.onclick=()=>{if(isCompared)comparison.delete(itemKey);else if(comparison.size>=maxComparisonCases){message('最多比较 '+maxComparisonCases+' 个附加 case（含主图共 20 个）',true);return}else comparison.set(itemKey,item);renderTree();queueRefresh()};
        row.appendChild(main);row.appendChild(compare);details.appendChild(row);
      });
    });
    if(!shown)tree.appendChild(el('p','muted',query?'没有匹配的 Plan 或 case':only?'尚未选择主图或对比 case':'暂无 case'));
    selectionSummary.textContent=(active?'主图：'+active.case:'尚未选择主图')+' · 对比 '+comparison.size+'/'+maxComparisonCases;
    document.getElementById('clearComparisons').disabled=comparison.size===0;
  }
  async function loadCatalog(){if(catalogLoading)return;catalogLoading=true;try{const result=await call('catalog');catalog=mergeCatalog(result);catalogReady=true;renderTree();message('目录已更新'+(result.offlineServers?.length?' · 离线 '+result.offlineServers.join(', '):''))}catch(error){if(error.name!=='AbortError'){catalogReady=false;message('目录读取失败，连接恢复后自动重试：'+error.message,true)}}finally{catalogLoading=false}}
  function stopObserving(){cancelRead('series');if(observer){observer.disconnect();observer=null}cards.clear();groupRoot.replaceChildren()}
  function visibleTags(){return [...cards].filter(([,card])=>card.details.open&&card.visible).map(([tag])=>tag).slice(0,32)}
  function queueRefresh(){pending=true;if(!refreshing)setTimeout(()=>{if(pending)void refreshVisible()},0)}
  async function selectCase(item){active=item;comparison.delete(key(item));generation++;const current=generation;cancelRead('tags');stopObserving();renderTree();document.getElementById('heading').textContent=item.case+' · 正在读取指标…';message('读取指标目录');try{const result=await call('tags',{planFile:item.planFile,case:item.case});if(current!==generation)return;const tags=result.tags||[];document.getElementById('heading').textContent=item.case+' · '+tags.length+' 个指标';renderCards(tags);message(tags.length?'已加载指标目录':'该 case 暂无标量指标');if(result.unsupportedFiles?.length)message('不支持的 event 文件：'+result.unsupportedFiles.join(', '),true)}catch(error){if(current===generation&&error.name!=='AbortError'){document.getElementById('heading').textContent='指标读取失败：'+error.message;message(error.message,true)}}}
  function renderCards(tags){
    const sections=new Map();
    tags.forEach(tag=>{
      const slash=tag.lastIndexOf('/'),category=slash>0?tag.slice(0,slash):'其他指标';
      let grid=sections.get(category);
      if(!grid){const section=el('details','group');section.open=true;section.appendChild(el('summary','',category));grid=el('div','chart-grid');section.appendChild(grid);groupRoot.appendChild(section);sections.set(category,grid)}
      const details=el('details','chart-card');details.open=true;details.dataset.tag=tag;details.appendChild(el('summary','',tag));
      const toolbar=el('div','toolbar'),smoothLabel=el('label','','平滑'),smooth=el('input');
      smooth.type='range';smooth.min='0';smooth.max='0.99';smooth.step='0.01';smooth.value=String(Number(localStorage.getItem('scalarSmooth')||0));
      const smoothValue=el('span','count',Number(smooth.value).toFixed(2));smoothLabel.appendChild(smooth);smoothLabel.appendChild(smoothValue);toolbar.appendChild(smoothLabel);
      const max=checkControl(toolbar,'最大值点',true),min=checkControl(toolbar,'最小值点',true),seed=checkControl(toolbar,'Seed 极值',true);
      const layoutButton=el('button','layout-button');layoutButton.type='button';toolbar.appendChild(layoutButton);details.appendChild(toolbar);
      const legend=el('div','legend');details.appendChild(legend);const canvas=el('canvas');details.appendChild(canvas);
      const tooltip=el('div','tooltip','等待曲线数据…');details.appendChild(tooltip);grid.appendChild(details);
      const card={tag,details,canvas,legend,tooltip,smooth,max,min,seed,layoutButton,charts:[],visible:false};cards.set(tag,card);
      function setFullRow(enabled,persist){details.classList.toggle('full-row',enabled);layoutButton.textContent=enabled?'恢复网格':'单行显示';layoutButton.setAttribute('aria-pressed',String(enabled));if(persist){localStorage.setItem(fullRowKey(tag),String(enabled));applyChartLayout()}}
      setFullRow(localStorage.getItem(fullRowKey(tag))==='true',false);
      layoutButton.onclick=()=>setFullRow(!details.classList.contains('full-row'),true);
      smooth.oninput=()=>{smoothValue.textContent=Number(smooth.value).toFixed(2);localStorage.setItem('scalarSmooth',smooth.value);drawCard(card)};
      [max,min,seed].forEach(input=>input.onchange=()=>drawCard(card));
      details.ontoggle=()=>{if(details.open){queueRefresh();drawCard(card)}else card.visible=false};
      canvas.onmousemove=event=>hoverCard(card,event);
    });
    applyChartLayout();
    if('IntersectionObserver' in window){observer=new IntersectionObserver(entries=>{let changed=false;entries.forEach(entry=>{const card=cards.get(entry.target.dataset.tag);if(card&&card.visible!==entry.isIntersecting){card.visible=entry.isIntersecting&&card.details.open;changed=true}});if(changed)queueRefresh()},{root:content,rootMargin:'120px'});cards.forEach(card=>observer.observe(card.details))}
    else{cards.forEach(card=>{card.visible=true});queueRefresh()}
  }
  function checkControl(parent,label,checked){const wrap=el('label'),input=el('input');input.type='checkbox';input.checked=checked;wrap.appendChild(input);wrap.appendChild(el('span','',label));parent.appendChild(wrap);return input}
  async function refreshVisible(){
    if(!active||document.hidden||scalarPage.hidden){pending=false;cancelRead('series');return}
    const tags=visibleTags();
    if(!tags.length){pending=false;cancelRead('series');return}
    const groups=[active,...[...comparison.values()].filter(item=>key(item)!==key(active))];
    const requestKey=JSON.stringify({groups:groups.map(key),tags});
    if(refreshing){pending=true;if(requestKey!==seriesRequestKey)cancelRead('series');return}
    pending=false;refreshing=true;seriesRequestKey=requestKey;lastRequest=Date.now();const current=generation;
    try{
      const result=await call('series',{groups,tags});
      if(current!==generation)return;
      for(const tag of tags){const card=cards.get(tag);if(!card)continue;card.charts=(result.charts||[]).filter(row=>row.tag===tag);drawCard(card)}
      backoff=0;message('更新于 '+new Date().toLocaleTimeString()+(result.offlineServers?.length?' · 离线 '+result.offlineServers.join(', '):''));
      if(result.unsupportedFiles?.length)message('不支持的 event 文件：'+result.unsupportedFiles.join(', '),true);
    }catch(error){
      if(error.name!=='AbortError'){backoff=Math.min(60000,Math.max(1000,backoff?backoff*2:Number(error.retryAfterMs)||1000));message('刷新延后 '+Math.ceil(backoff/1000)+' 秒：'+error.message,true)}
    }finally{
      refreshing=false;seriesRequestKey='';scheduleAutoRefresh();
      if(pending){pending=false;setTimeout(()=>void refreshVisible(),Math.max(0,backoff))}
    }
  }
  function chartSeries(card){card.displaySeries=card.charts.map((row,index)=>{const mean=(row.points||[]).map(point=>({step:point.step,value:point.mean,source:point}));const means=smoothScalarValues(mean.map(point=>point.value),Number(card.smooth.value));return{row,index,color:palette[index%palette.length],mean,means}});return card.displaySeries}
  function limits(series,card){
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    const add=(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y))return;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)};
    for(const line of series){
      line.mean.forEach((point,index)=>{add(point.step,point.value);add(point.step,line.means[index])});
      if(band.checked)scalarStdSegments(line.row.points||[]).forEach(segment=>segment.forEach(point=>{add(point.step,point.low);add(point.step,point.high)}));
      if(raw.checked||card.seed.checked||line.row.rawOnly)(line.row.seeds||[]).forEach(seed=>(seed.points||[]).forEach(point=>add(point[0],point[1])));
    }
    if(x0===Infinity)return null;
    if(x0===x1)x1=x0+1;
    if(y0===y1){y0-=1;y1+=1}
    const pad=(y1-y0)*0.06;
    return{x0,x1,y0:y0-pad,y1:y1+pad};
  }
  function marker(ctx,x,y,kind,isSeed){ctx.save();ctx.fillStyle=kind==='max'?'#e44836':'#2563eb';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();if(isSeed){const size=5;if(kind==='max'){ctx.moveTo(x,y-size);ctx.lineTo(x-size,y+size);ctx.lineTo(x+size,y+size)}else{ctx.moveTo(x,y+size);ctx.lineTo(x-size,y-size);ctx.lineTo(x+size,y-size)}ctx.closePath()}else ctx.arc(x,y,6,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore()}
  function drawCard(card){
    if(!card.details.open||!card.visible)return;
    const canvas=card.canvas,rect=canvas.getBoundingClientRect(),w=Math.max(300,rect.width),h=Math.max(190,rect.height),ratio=Math.min(2,devicePixelRatio||1);
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);
    const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.clearRect(0,0,w,h);
    const series=chartSeries(card),bounds=limits(series,card);
    card.markers=[];card.legend.replaceChildren();
    if(!bounds){card.plot=null;card.hoverPoint=null;ctx.fillStyle='#64748b';ctx.fillText('暂无曲线数据',22,32);showHoverHint(card);return}
    const left=54,right=w-18,top=16,bottom=h-34,X=value=>left+(value-bounds.x0)/(bounds.x1-bounds.x0)*(right-left),Y=value=>bottom-(value-bounds.y0)/(bounds.y1-bounds.y0)*(bottom-top);
    card.plot={bounds,left,right};
    ctx.font='11px system-ui';ctx.strokeStyle='#dce4ed';ctx.fillStyle='#68778e';
    for(let index=0;index<=4;index++){const y=top+(bottom-top)*index/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText((bounds.y1-(bounds.y1-bounds.y0)*index/4).toPrecision(3),4,y+4)}
    ctx.fillText(String(bounds.x0),left,bottom+20);ctx.fillText(String(bounds.x1),Math.max(left,right-40),bottom+20);
    for(const line of series){
      const row=line.row,points=line.mean,color=line.color,last=points.at(-1)?.source;
      const pill=el('span','pill',row.case+' · '+(row.rawOnly?'原始 '+row.seeds.length+' 条':points.length+' 个 step · 末步 '+(last?.n||0)+'/'+(row.expectedSeeds||'?')+' seed'));
      pill.title=row.rawOnly?'未归属日志：只显示可辨认的原始曲线。':'末步参与数表示最后一个 step 的有效 seed 数；其他 step 可有不同数量。';
      pill.style.borderLeft='4px solid '+color;card.legend.appendChild(pill);
    }
    // Fill every deviation band before any line, so a later case cannot cover an earlier line.
    if(band.checked)for(const line of series){
      ctx.fillStyle=line.color+'30';
      for(const segment of scalarStdSegments(line.row.points||[])){
        if(segment.length<2)continue;
        ctx.beginPath();
        segment.forEach((point,index)=>{if(!index)ctx.moveTo(X(point.step),Y(point.high));else ctx.lineTo(X(point.step),Y(point.high))});
        segment.slice().reverse().forEach(point=>ctx.lineTo(X(point.step),Y(point.low)));
        ctx.closePath();ctx.fill();
      }
    }
    for(const line of series){
      const showRaw=raw.checked||line.row.rawOnly;
      if(showRaw)(line.row.seeds||[]).forEach(seed=>{
        ctx.strokeStyle=line.color+'55';ctx.lineWidth=0.9;
        const ys=smoothScalarValues((seed.points||[]).map(point=>point[1]),Number(card.smooth.value));
        trace(ctx,(seed.points||[]).map((point,index)=>[point[0],ys[index]]),X,Y);
      });
    }
    // A dashed raw mean stays distinct from the solid, heavier smoothed mean.
    if(series.some(line=>line.mean.length)&&Number(card.smooth.value)>0)for(const line of series){
      if(!line.mean.length)continue;
      ctx.strokeStyle=line.color+'99';ctx.lineWidth=1.2;ctx.setLineDash([4,3]);
      trace(ctx,line.mean.map(point=>[point.step,point.value]),X,Y);
    }
    ctx.setLineDash([]);
    for(const line of series){
      if(!line.mean.length)continue;
      ctx.strokeStyle=line.color;ctx.lineWidth=2.6;
      trace(ctx,line.mean.map((point,index)=>[point.step,line.means[index]]),X,Y);
    }
    for(const line of series){
      const row=line.row,points=line.mean,color=line.color;
      const marked=(values,label,isSeed)=>{
        for(const kind of ['max','min']){
          if(kind==='max'&&!card.max.checked||kind==='min'&&!card.min.checked)continue;
          const hit=scalarExtreme(values,kind);if(!hit)continue;
          const x=X(hit.step),y=Y(hit.value);marker(ctx,x,y,kind,isSeed);
          card.markers.push({x,y,detail:{case:row.case,color,label:label+' '+(kind==='max'?'最大':'最小'),step:hit.step,value:hit.value}});
        }
      };
      marked(points.map(point=>({step:point.step,value:point.value})),'均值',false);
      if(card.seed.checked)(row.seeds||[]).forEach(seed=>marked((seed.points||[]).map(point=>({step:point[0],value:point[1]})),'seed '+seed.seed,true));
    }
    if(card.hoverPoint)hoverCard(card,card.hoverPoint);else showHoverHint(card);
  }
  function trace(ctx,points,X,Y){ctx.beginPath();points.forEach((point,index)=>{if(!index)ctx.moveTo(X(point[0]),Y(point[1]));else ctx.lineTo(X(point[0]),Y(point[1]))});ctx.stroke()}
  function nearestIndex(points,step,readStep){let lo=0,hi=points.length;while(lo<hi){const mid=(lo+hi)>>1;if(readStep(points[mid])<step)lo=mid+1;else hi=mid}if(lo<=0)return 0;if(lo>=points.length)return points.length-1;return Math.abs(readStep(points[lo])-step)<Math.abs(readStep(points[lo-1])-step)?lo:lo-1}
  function showHoverHint(card){card.tooltip.replaceChildren(el('div','hover-hint','悬停曲线或极值点查看数值'))}
  function renderHoverDetails(card,entries){
    if(!entries.length){showHoverHint(card);return}
    const table=el('table','hover-table'),head=el('thead'),heading=el('tr');
    const textWidth=value=>Array.from(String(value)).reduce((width,character)=>width+(character.codePointAt(0)>255?2:1),0);
    const available=Number(card.tooltip.clientWidth)||Infinity;
    const caseChars=Math.max(8,...entries.map(entry=>textWidth(entry.case+(entry.label?' · '+entry.label:''))+2));
    const caseLimit=Math.max(8,Math.floor(available*.4/7));
    table.style.setProperty('--hover-case-width',Math.min(50,caseLimit,caseChars)+'ch');
    table.style.setProperty('--hover-step-width',Math.max(6,...entries.map(entry=>String(entry.step).length+2))+'ch');
    const seedIds=[...new Set(entries.flatMap(entry=>entry.seedIds?.length?entry.seedIds:Object.keys(entry.seeds||{})).map(String))].sort((a,b)=>{const difference=Number(a)-Number(b);return Number.isFinite(difference)&&difference?difference:a.localeCompare(b)});
    const seedChars=Math.max(12,...seedIds.map(seed=>textWidth(seed)+2),...entries.flatMap(entry=>Object.values(entry.seeds||{}).map(value=>Number(value).toPrecision(4).length+2)));
    table.style.setProperty('--hover-seed-width',Math.min(18,seedChars)+'ch');
    const columns=el('colgroup');['case-column','step-column','','extra-column','extra-column',''].forEach(cls=>columns.appendChild(el('col',cls)));seedIds.forEach(()=>columns.appendChild(el('col','seed-value-column')));table.appendChild(columns);
    const valueLabel=entries.every(entry=>entry.mean!==undefined)?'均值':entries.every(entry=>entry.label?.includes('最大')||entry.label?.includes('最小'))?'极值':'原值';
    [['case',''],['step','step-column'],[valueLabel,''],['平滑','extra-column'],['标准差','extra-column'],['参与','']].forEach(([label,cls])=>heading.appendChild(el('th',cls,label)));
    seedIds.forEach(seed=>{const cell=el('th','seed-value-column',seed);cell.title='seed '+seed;heading.appendChild(cell)});
    head.appendChild(heading);table.appendChild(head);
    const body=el('tbody');
    for(const entry of entries){
      const row=el('tr');row.style.setProperty('--series-color',entry.color);
      const values=[entry.case+(entry.label?' · '+entry.label:''),String(entry.step),Number(entry.value??entry.mean).toPrecision(6),entry.smooth===undefined?'—':Number(entry.smooth).toPrecision(6),entry.std===undefined||entry.std===null?'—':Number(entry.std).toPrecision(5),entry.n===undefined?'—':entry.n+'/'+(entry.expectedSeeds||'?')];
      values.forEach((value,columnIndex)=>{
        const cls=columnIndex===1?'step-column':columnIndex===3||columnIndex===4?'extra-column':'';
        const cell=el('td',cls,value);cell.title=value;row.appendChild(cell);
      });
      const seedSummary=seedIds.map(seed=>seed+':'+(Object.prototype.hasOwnProperty.call(entry.seeds||{},seed)?Number(entry.seeds[seed]).toPrecision(4):'—')).join(' · ');
      seedIds.forEach(seed=>{const hasValue=Object.prototype.hasOwnProperty.call(entry.seeds||{},seed);const value=hasValue?Number(entry.seeds[seed]).toPrecision(4):'—';const cell=el('td','seed-value-column',value);cell.title='seed '+seed+': '+value;row.appendChild(cell)});
      row.title='case '+values[0]+' · step '+values[1]+' · '+valueLabel+' '+values[2]+' · 平滑 '+values[3]+' · 标准差 '+values[4]+' · seed '+values[5]+(seedSummary?' · '+seedSummary:'');
      body.appendChild(row);
    }
    table.appendChild(body);card.tooltip.replaceChildren(table);
  }
  function hoverCard(card,event){
    if(!card.plot)return;
    card.hoverPoint={offsetX:event.offsetX,offsetY:event.offsetY};
    const markerHit=card.markers.find(point=>Math.hypot(point.x-event.offsetX,point.y-event.offsetY)<9);
    if(markerHit){renderHoverDetails(card,[markerHit.detail]);return}
    const view=card.plot,step=view.bounds.x0+(event.offsetX-view.left)/(view.right-view.left)*(view.bounds.x1-view.bounds.x0),entries=[];
    for(const line of card.displaySeries||[]){
      const row=line.row,points=row.points||[];
      if(points.length){
        const index=nearestIndex(points,step,point=>point.step),point=points[index];
        entries.push({case:row.case,color:line.color,step:point.step,mean:point.mean,smooth:Number(card.smooth.value)>0?line.means[index]:undefined,std:point.std,n:point.n,expectedSeeds:row.expectedSeeds,seeds:point.seeds,seedIds:(row.seeds||[]).map(seed=>seed.seed)});
      }else if(row.rawOnly)(row.seeds||[]).forEach(seed=>{
        const values=seed.points||[];
        if(values.length){const point=values[nearestIndex(values,step,value=>value[0])];entries.push({case:row.case,color:line.color,label:'seed '+seed.seed,step:point[0],value:point[1],seeds:{[seed.seed]:point[1]},seedIds:(row.seeds||[]).map(item=>item.seed)})}
      });
    }
    renderHoverDetails(card,entries);
  }
  document.getElementById('refresh').onclick=()=>active?queueRefresh():void loadCatalog();document.getElementById('settingsButton').onclick=()=>document.getElementById('settings').classList.toggle('open');
  caseSearch.oninput=renderTree;selectedOnly.onchange=renderTree;
  document.getElementById('clearComparisons').onclick=()=>{comparison.clear();renderTree();queueRefresh()};
  let dragStartX=0,dragStartWidth=310,dragging=false;
  sidebarHandle.onpointerdown=event=>{if(event.button!==0)return;dragging=true;dragStartX=event.clientX;dragStartWidth=Number.parseInt(scalarPage.style.getPropertyValue('--sidebar-width'),10)||310;sidebarHandle.classList.add('dragging');sidebarHandle.setPointerCapture(event.pointerId);event.preventDefault()};
  sidebarHandle.onpointermove=event=>{if(dragging)setSidebarWidth(dragStartWidth+event.clientX-dragStartX,false)};
  function finishSidebarDrag(){if(!dragging)return;dragging=false;sidebarHandle.classList.remove('dragging');setSidebarWidth(Number.parseInt(scalarPage.style.getPropertyValue('--sidebar-width'),10),true);applyChartLayout()}
  sidebarHandle.onpointerup=finishSidebarDrag;sidebarHandle.onpointercancel=finishSidebarDrag;
  sidebarHandle.onkeydown=event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const current=Number.parseInt(scalarPage.style.getPropertyValue('--sidebar-width'),10)||310;setSidebarWidth(current+(event.key==='ArrowRight'?20:-20),true);applyChartLayout()};
  function scheduleAutoRefresh(){
    clearTimeout(autoRefreshTimer);autoRefreshTimer=0;
    if(document.hidden||scalarPage.hidden||!auto.checked||!active)return;
    const wait=Math.max(1000,Number(interval.value)*1000,backoff);
    autoRefreshTimer=setTimeout(()=>{autoRefreshTimer=0;if(Date.now()-lastRequest>=wait)queueRefresh();scheduleAutoRefresh()},Math.max(250,wait-(Date.now()-lastRequest)));
  }
  function scheduleConnectionCheck(delay){
    clearTimeout(connectionTimer);connectionTimer=0;
    if(document.hidden)return;
    connectionTimer=setTimeout(()=>{connectionTimer=0;void checkLocalConnection().finally(()=>scheduleConnectionCheck(2500))},Math.max(250,Number(delay)||2500));
  }
  interval.onchange=()=>{interval.value=String(Math.max(1,Math.floor(Number(interval.value)||5)));localStorage.setItem('scalarInterval',interval.value);scheduleAutoRefresh()};columns.onchange=()=>{columns.value=String(Math.max(1,Math.min(6,Math.floor(Number(columns.value)||3))));localStorage.setItem('scalarColumns',columns.value);applyChartLayout()};auto.onchange=()=>{localStorage.setItem('scalarAuto',String(auto.checked));scheduleAutoRefresh()};band.onchange=()=>{localStorage.setItem('scalarBand',String(band.checked));cards.forEach(drawCard)};raw.onchange=()=>{localStorage.setItem('scalarRaw',String(raw.checked));cards.forEach(drawCard)};window.addEventListener('resize',()=>{setSidebarWidth(localStorage.getItem('scalarSidebarWidth'),false);applyChartLayout()});
  document.getElementById('scalarTab').onclick=function(){cancelRead('tags');cancelRead('series');document.getElementById('scalarPage').hidden=false;document.getElementById('nativePage').hidden=true;this.classList.add('active');document.getElementById('nativeTab').classList.remove('active');applyChartLayout();queueRefresh();scheduleAutoRefresh()};
  async function openNative(){
    if(nativeStarted||nativeOpening||Date.now()<nextNativeAttempt)return;
    nativeOpening=true;
    try{message('连接图像、直方图和网络图…');await call('native.open');document.getElementById('nativeFrame').src='/api/tensorboard/ui/?server='+encodeURIComponent(server)+'&reload='+Date.now();nativeStarted=true;nextNativeAttempt=0;message('原生内容已连接')}
    catch(error){nextNativeAttempt=Date.now()+Math.max(5000,Number(error.retryAfterMs)||0);message('原生内容等待连接：'+error.message,true)}
    finally{nativeOpening=false}
  }
  document.getElementById('nativeTab').onclick=function(){cancelRead('tags');cancelRead('series');clearTimeout(autoRefreshTimer);autoRefreshTimer=0;this.classList.add('active');document.getElementById('scalarTab').classList.remove('active');document.getElementById('scalarPage').hidden=true;document.getElementById('nativePage').hidden=false;void openNative()};
  async function checkLocalConnection(){
    if(document.hidden||connectionChecking)return;
    connectionChecking=true;
    const controller=new AbortController();connectionController=controller;
    const deadline=setTimeout(()=>controller.abort(),3000);
    try{
      const response=await fetch('/tensorboard/health?server='+encodeURIComponent(server),{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const health=await response.json();
      if(!health.ok||!health.epoch)throw new Error('本机接口尚未就绪');
      const restarted=!!localEpoch&&localEpoch!==health.epoch;
      localEpoch=health.epoch;
      if(restarted){message('插件已重连，正在恢复曲线数据');catalogReady=false;nativeStarted=false;nextNativeAttempt=0;if(active)queueRefresh()}
      if(!catalogReady)void loadCatalog();
      if(!document.getElementById('nativePage').hidden&&!nativeStarted)void openNative();
    }catch(error){if(error.name!=='AbortError'&&!document.hidden)message('等待插件本机接口恢复：'+error.message,true)}
    finally{clearTimeout(deadline);if(connectionController===controller)connectionController=null;connectionChecking=false}
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){clearTimeout(autoRefreshTimer);autoRefreshTimer=0;clearTimeout(connectionTimer);connectionTimer=0;if(connectionController)connectionController.abort();cancelScalarReads();pending=false;return}
    void checkLocalConnection().finally(()=>scheduleConnectionCheck(250));
    scheduleAutoRefresh();
    if(active)queueRefresh();
  });
  window.addEventListener('pagehide',()=>{clearTimeout(autoRefreshTimer);clearTimeout(connectionTimer);autoRefreshTimer=0;connectionTimer=0;if(connectionController)connectionController.abort();cancelScalarReads()},{once:true});
  void checkLocalConnection().finally(()=>scheduleConnectionCheck(2500));
})();
</script></body></html>`;
