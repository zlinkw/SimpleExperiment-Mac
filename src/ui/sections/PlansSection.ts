import type { Section } from "./types";

/**
 * PlansSection - 实验准备板块
 * 提取自 PanelHtml.ts 1254-1288 section[data-section="plans"]
 */
export class PlansSection implements Section {
  readonly id = "plans";
  readonly title = "实验准备";
  readonly order = 2;
  renderHtml(_state?: unknown): string {
    return `
      <section class="section-card" data-section="plans" data-anchor="plans" data-title="实验准备">
        <div class="section-head">
          <div class="section-title">
            <h2>实验准备</h2>
            <div class="section-desc">Plan、校验、预演、运行</div>
          </div>
          <div class="toolbar">
            <button data-command="bootstrapProject">接入当前项目</button>
            <button data-command="snapshot" class="secondary">刷新识别</button>
          </div>
        </div>
        <div id="planDetectedProject" data-anchor="plans-detected"></div>
        <div id="planQuickGrid" class="planQuickGrid" data-anchor="plans-actions">
          <div class="field wide">
            <label>计划文件</label>
            <input id="planFileInput" class="wide" placeholder="experiments/plans/example.yaml">
          </div>
          <div class="runModeBar">
            <span class="muted">运行类型</span>
            <div class="runModeSwitch" role="group" aria-label="运行类型">
              <button type="button" data-run-mode="formal" class="is-active" aria-pressed="true">正式运行</button>
              <button type="button" data-run-mode="debug" aria-pressed="false">Debug</button>
            </div>
            <span id="runModeNote" class="runModeNote">完整执行 Plan，结果进入正式闭环</span>
          </div>
          <button data-command="validatePlan">校验</button>
          <button data-command="dryRunPlan" class="secondary">预演</button>
          <button data-command="runPlan" data-confirm="true">校验并提交运行</button>
          <button data-command="runAllPlans" data-confirm="true" class="secondary">运行全部计划</button>
        </div>
        <div id="recentPlans" data-anchor="plans-list"></div>
        <div id="draftPlans" data-anchor="draft-list"></div>
        <h3>实验操作</h3>
        <div id="experimentActions" class="actionGrid"></div>
      </section>`;
  }
  renderCss(): string {
    return `
    .planQuickGrid { display: grid; gap: 8px; }
    .runModeBar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .runModeSwitch { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
    .runModeSwitch button.is-active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
`;
  }
  renderScript(): string {
    return `
function renderPlans(state){
  var el=document.querySelector('[data-section="plans"]');
  if(!el) return;
}
`;
  }
}
export const plansSection = new PlansSection();
export default PlansSection;
