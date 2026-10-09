import type { Section } from "./types";

/**
 * ResultsSection - 结果文件板块
 * 提取自 PanelHtml.ts 1290-1332 section[data-section="results"]
 */
export class ResultsSection implements Section {
  readonly id = "results";
  readonly title = "结果文件";
  readonly order = 6;
  renderHtml(_state?: unknown): string {
    return `
      <section class="section-card" data-section="results" data-anchor="results" data-title="结果文件">
        <div class="section-head">
          <div class="section-title">
            <h2>结果文件</h2>
            <div class="section-desc">按数据集浏览总表、方法结果与原始文件</div>
          </div>
        </div>
        <div class="resultMainPane">
          <div id="resultSummary" data-anchor="results-summary"></div>
          <div class="resultRelatedTools" data-anchor="results-contract">
            <span class="resultRelatedToolsLabel">相关检查</span>
            <div class="contractQuickLinks">
              <a id="results-contract" class="summaryLink" href="#results-contract" title="metrics/case/env/artifact">输出契约</a>
              <a id="results-dataset" class="summaryLink" data-anchor="results-dataset" href="#results-dataset" title="CSV/split/leakage">数据集画像</a>
              <a id="results-checkpoints" class="summaryLink" data-anchor="results-checkpoints" href="#results-checkpoints" title="dry-run/retention">检查点清理预案</a>
              <a id="results-plotting" class="summaryLink" data-anchor="results-plotting" href="#results-plotting" title="registry/statistics/table">PPT 绘图契约</a>
            </div>
          </div>
        </div>
        <details class="resultArtifactGroup" data-details-key="results-ppt-plot">
          <summary>绘图到 PPT（可选）</summary>
          <div id="pptPlotConfig" data-anchor="results-ppt-plot"></div>
        </details>
      </section>`;
  }
  renderCss(): string { return ""; }
  renderScript(): string {
    return `
function renderResults(state){
  var el=document.querySelector('[data-section="results"]');
  if(!el) return;
}
`;
  }
}
export const resultsSection = new ResultsSection();
export default ResultsSection;
