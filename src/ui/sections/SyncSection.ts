import type { Section } from "./types";

/**
 * SyncSection - 运行环境准备板块（目标序第1位）
 * 运行时顺序以 legacy RESOURCE 为准
 */
export class SyncSection implements Section {
  readonly id = "sync";
  readonly title = "运行环境准备";
  readonly order = 1;
  renderHtml(_state?: unknown): string {
    return `
    <section class="section-card" data-section="sync" data-anchor="sync" data-title="运行环境准备">
      <div class="section-head">
        <div class="section-title">
          <h2>运行环境准备</h2>
        </div>
      </div>
      <div id="syncChainOverview" data-anchor="settings-chain-overview"></div>
      <div id="syncServerOverview" data-anchor="sync-servers"></div>
      <div id="syncCheckStaticReports" data-anchor="sync-check-reports"></div>
      <div class="toolbar" data-anchor="sync-check-actions">
        <button type="button" data-command="runCheckStatic" title="运行静态检查，生成项目接入报告&#10;覆盖实验计划结构、输出接口与路径安全&#10;报告写入 simple_cluster/check_reports/&#10;查看报告：到「诊断与自检」卡片点「打开静态检查报告」">检查项目配置</button>
        <button type="button" class="danger-filled" data-command="overwriteGithub" data-danger="true" data-confirm="true" data-anchor="sync-actions-danger" title="危险操作：用 GitHub 远端覆盖本机工作区&#10;未提交的改动会丢失，执行前会要求确认">从 GitHub 覆盖本机</button>
      </div>
      <div class="toolbar" data-anchor="sync-actions">
        <button type="button" data-command="prepareAgents" title="第 1 步 · 先部署&#10;上传最新版 Agent 到全部服务器并启动&#10;无需隧道在线">部署Agent</button>
        <span class="toolbarSep" aria-hidden="true">→</span>
        <button type="button" data-command="startAll" class="secondary" title="第 1 步 · 连隧道&#10;启动全部 Xshell 隧道，建立本机到服务器的端口转发">启动全部隧道</button>
        <span class="toolbarSep" aria-hidden="true">→</span>
        <button type="button" data-command="publishGithub" data-confirm="true" title="第 2 步 · 传代码&#10;先提交推送到 GitHub（未配置会引导登录）&#10;再通过 SimpleSFTP 上传到所有 Worker；无 Hub 模式会跳过 Hub 上传">发布到git并上传worker</button>
        <span class="toolbarSep" aria-hidden="true">→</span>
        <button type="button" data-command="testAll" class="secondary" title="第 3 步 · 检测&#10;检测全部服务器隧道、Agent 与调度依赖&#10;失败项会列出原因">检测全部</button>
      </div>
    </section>`;
  }
  renderCss(): string { return ""; }
  renderScript(): string {
    return `
function renderSync(state){
  var el=document.querySelector('[data-section="sync"]');
  if(!el) return;
  var box=el.querySelector('#syncCheckStaticReports');
  if(!box) return;
  var reports=state && state.checkStaticReports ? state.checkStaticReports : [];
  var esc=function(s){ return String(s).replace(/[&<>"]/g, function(ch){ return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]; }); };
  var list=[];
  for(var i=0;i<reports.length;i+=1){
    var nm=String(reports[i] || "");
    if(!nm || nm.indexOf("..")>=0 || nm.indexOf("/")>=0) continue;
    list.push('<button type="button" class="mini secondary" data-command="openLastCheckStaticReport" data-report="' + esc(nm) + '" data-file="' + esc("simple_cluster/check_reports/" + nm) + '" title="' + esc("simple_cluster/check_reports/" + nm) + '">' + esc(nm) + '</button>');
  }
  var head='<div class="muted">静态检查报告（' + String(list.length) + '）：点击文件名打开对应报告；检查按钮每次先清空旧报告再写最新。</div>';
  box.innerHTML = list.length ? head + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">' + list.join("") + '</div>' : head + '<div class="muted">暂无报告，点击上方检查项目配置生成。</div>';
}
`;
  }
}
export const syncSection = new SyncSection();
export default SyncSection;
