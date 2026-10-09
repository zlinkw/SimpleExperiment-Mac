import type { Section } from "./types";

/**
 * DiagnosticsSection - 诊断/自检板块
 * 提取自 PanelHtml.ts 1400-1450 section[data-section="diagnostics"]
 */
export class DiagnosticsSection implements Section {
  readonly id = "diagnostics";
  readonly title = "诊断与自检";
  readonly order = 7;
  renderHtml(_state?: unknown): string {
    return `
    <section class="section-card" data-section="diagnostics" data-anchor="diagnostics" data-title="诊断与自检">
      <div class="section-head">
        <div class="section-title">
          <h2>诊断与自检</h2>
          <div class="section-desc">服务器健康状态与待处理问题</div>
        </div>
      </div>
      <div id="diagnosticOverview" class="diagnosticOverview"></div>
      <details class="diagnosticAllChecks" data-details-key="diagnostics-all-checks">
        <summary>全部检查记录与工具</summary>
        <div id="diagnosticActions" class="actionGrid"></div>
        <div class="toolbar" title="静态检查报告：failed 自动落盘，passed 加 --write-md/--report-md">
          <button data-command="openLastCheckStaticReport" type="button">打开静态检查报告</button>
          <button data-command="copyLastCheckStaticReport" type="button">复制静态检查报告</button>
        </div>
        <div id="targetCompletionMatrix" data-anchor="diagnostics-targets"></div>
        <div id="featureReadiness" data-anchor="diagnostics-audit"></div>
        <div id="actionErrors" data-anchor="diagnostics-errors"></div>
      </details>
      <details class="advanced">
        <summary>高级诊断</summary>
        <div class="toolbar" title="插件不内置 SSH；Hub 和 Worker 连接由 Xshell 本地端口转发提供">
          <button data-command="startHub" type="button">启动 Hub</button>
          <button data-command="startWorker" type="button">启动 Worker</button>
          <button data-command="configurePorts" class="secondary" type="button">配置端口</button>
          <button data-command="repairPorts" class="secondary" type="button">处理端口冲突</button>
        </div>
        <h3>配置来源</h3>
        <div id="configurationSources" data-anchor="diagnostics-config-sources"></div>
        <h3>Hub 控制面</h3>
        <div id="hubControlStatus" data-anchor="diagnostics-hub-control"></div>
        <h3>Worker 实时观测</h3>
        <div id="workerTelemetryStatus" data-anchor="diagnostics-worker-telemetry"></div>
        <h3>隧道端口分配</h3>
        <div id="tunnelPortAssignments" data-anchor="diagnostics-ports"></div>
        <h3>端口冲突</h3>
        <div id="tunnelPortConflicts" data-anchor="diagnostics-conflicts"></div>
        <h3>能力状态</h3>
        <div id="capabilities" data-anchor="diagnostics-capabilities"></div>
        <h3>诊断 JSON</h3>
        <pre id="details" data-anchor="diagnostics-json">待展开</pre>
      </details>
    </section>`;
  }
  renderCss(): string { return ""; }
  renderScript(): string {
    return `
function renderDiagnostics(state){
  var el=document.querySelector('[data-section="diagnostics"]');
  if(!el) return;
}
`;
  }
}
export const diagnosticsSection = new DiagnosticsSection();
export default DiagnosticsSection;
