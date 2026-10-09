import type { Section } from "./types";

/**
 * ExecutionSection - 执行进展板块
 * 提取自 PanelHtml.ts 1376-1398 section[data-section="execution"]
 */
export class ExecutionSection implements Section {
  readonly id = "execution";
  readonly title = "运行进度";
  readonly order = 5;
  renderHtml(_state?: unknown): string {
    return `
    <section class="section-card" data-section="execution" data-anchor="execution" data-title="运行进度">
      <div class="section-head">
          <div class="section-title">
            <h2>运行进度</h2>
            <div class="section-desc">按 Plan 查看进度；展开单行查看任务和日志</div>
          </div>
          <div class="section-head-actions">
            <span class="pill" title="按提交顺序排列；完成记录折叠">按 Plan</span>
          </div>
      </div>
      <div id="executionControls" class="executionControls"></div>
      <div id="executionPlanList" data-anchor="execution-operations"></div>
      <div id="taskBatchActions" class="actionGrid"></div>
      <details class="executionFullRecords" data-details-key="execution-full-records">
        <summary>高级：完整操作记录</summary>
        <div id="operationList"></div>
      </details>
      <div hidden data-anchor="tasks"></div>
      <div hidden data-anchor="operations"></div>
      <div hidden data-anchor="tasks-summary"></div>
      <div hidden data-anchor="operations-list"></div>
    </section>`;
  }
  renderCss(): string {
    return `
    #taskBatchActions:empty { display: none; }
`;
  }
  renderScript(): string {
    return `
function renderExecution(state){
  var el=document.querySelector('[data-section="execution"]');
  if(!el) return;
}
`;
  }
}
export const executionSection = new ExecutionSection();
export default ExecutionSection;
