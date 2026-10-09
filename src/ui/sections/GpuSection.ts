import type { Section } from "./types";

export class GpuSection implements Section {
  readonly id = "gpu";
  readonly title = "GPU 状态";
  readonly order = 3;
  renderHtml(_state?: unknown): string {
    return `
    <section class="section-card" data-section="gpu" data-anchor="gpu" data-title="GPU 状态">
      <div class="section-head">
        <div class="section-title">
          <h2>GPU 状态</h2>
          <div class="section-desc">显存、利用率、温度、进程 — 密集大表（双击行展开曲线+进程）</div>
        </div>
        <div class="gpuDenseToolbar">
          <button type="button" class="mini secondary" data-command="snapshot" title="刷新GPU状态">刷新</button>
          <button type="button" class="mini secondary" id="gpuMergeToggle" title="切换 服务器列 合并/打散">合并:开</button>
          <button type="button" class="mini secondary" id="gpuDenseSettingsBtn" title="自定义列与全局行高">⚙</button>
        </div>
      </div>
      <div id="gpuDenseGear" class="gpuDenseGear" hidden>
        <div class="gpuDenseGearHead"><b>自定义列</b><button type="button" class="mini secondary" id="gpuDenseGearClose">关闭</button></div>
        <div id="gpuDenseColumnsPicker" class="gpuDenseColumnsPicker"></div>
        <div class="gpuDenseGearRow">
          <span>全局行高</span>
          <input type="range" id="gpuDenseRowHeightSlider" min="24" max="48" step="1" />
          <span id="gpuDenseRowHeightValue">32px</span>
        </div>
        <div class="muted">列宽：拖动表头竖线（60-400px）；行高：拖动行底横线（24-48px）或滑杆；均存 localStorage</div>
      </div>
      <div id="gpuHistoryOverview" data-anchor="gpu-history-overview"></div>
      <div id="gpuSummary" data-anchor="gpu-summary"></div>
      <div id="gpuDenseTableWrap" class="gpuDenseTableWrap"><table id="gpuDenseTable" class="gpuDenseTable"><colgroup id="gpuDenseCols"></colgroup><thead id="gpuDenseHead"></thead><tbody id="gpuDenseBody"></tbody></table></div>
      <div id="gpuGrid" class="gpuServerStack" data-anchor="gpu-grid" style="display:none"></div>
    </section>`;
  }
  renderCss(): string {
    return `
    .gpuDenseToolbar{ display:flex; gap:6px; align-items:center; }
    .gpuDenseTableWrap{ overflow:auto; max-width:100%; border:1px solid var(--border); border-radius:6px; }
    .gpuDenseTable{ border-collapse:collapse; width:100%; min-width:100%; table-layout:fixed; font-size:12px; }
    .gpuDenseTable th, .gpuDenseTable td{ border:1px solid var(--border); padding:6px 8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; position:relative; }
    .gpuDenseTable th{ background:var(--subtle-bg); user-select:none; cursor:pointer; }
    .gpuDenseTable th .colResizer{ position:absolute; right:0; top:0; width:6px; height:100%; cursor:col-resize; background:transparent; }
    .gpuDenseTable tbody tr{ transition: background .15s; }
    .gpuDenseTable tbody tr:hover{ filter: brightness(0.97); }
    .gpuDenseTable .expandRow td{ white-space:normal; padding:10px; }
    .gpuDenseTable .expandChartWrap canvas{ width:100%; height:160px; }
    .gpuDenseTable .processTable{ width:100%; border-collapse:collapse; font-size:12px; }
    .gpuDenseTable .processTable th, .gpuDenseTable .processTable td{ border:1px solid var(--border); padding:4px 6px; }
    .gpuDenseTable .processTable td.cmd{ white-space:pre-wrap; word-break:break-all; max-width:520px; }
    .gpuDenseTable .rowResizer{ position:absolute; left:0; right:0; bottom:0; height:4px; cursor:row-resize; background:transparent; }
    .gpuDenseGear{ border:1px solid var(--border); border-radius:6px; padding:10px; background:var(--subtle-bg); display:grid; gap:8px; margin:8px 0; }
    .gpuDenseGear[hidden]{ display:none !important; }
    .gpuDenseGearHead{ display:flex; justify-content:space-between; align-items:center; }
    .gpuDenseColumnsPicker{ display:flex; flex-wrap:wrap; gap:8px; }
    .gpuDenseColumnsPicker label{ display:flex; gap:4px; align-items:center; font-size:12px; }
    .gpuDenseGearRow{ display:flex; gap:8px; align-items:center; }
    .gpuServerStack{ display:grid; gap:10px; }
    `;
  }
  renderScript(): string {
    return `
function renderGpu(state){ renderGpuDenseTable(state); }
`;
  }
}
export const gpuSection = new GpuSection();
export default GpuSection;
