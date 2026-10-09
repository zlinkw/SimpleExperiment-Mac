import type { Section } from "./types";

/**
 * TmuxSection - TMUX 会话板块
 * 提取自 PanelHtml.ts 1345-1390 section[data-section="tmux"]
 */
export class TmuxSection implements Section {
  readonly id = "tmux";
  readonly title = "TMUX 会话 / 窗口 / 窗格";
  readonly order = 4;
  renderHtml(_state?: unknown): string {
    return `
         <section class="section-card" data-section="tmux" data-anchor="tmux" data-title="TMUX 会话 / 窗口 / 窗格">
       <div class="section-head">
         <div class="section-title">
           <h2>TMUX 会话 / 窗口 / 窗格</h2>
           <div class="section-desc">默认展示所有窗口卡片，点击卡片切换 capture-pane；窗口数量按服务器 GPU 数量动态生成</div>
         </div>
         <div class="cardTools">
           <button id="tmuxRefreshBtn" class="secondary" type="button">刷新 capture</button>
           <button id="tmuxListBtn" class="secondary" type="button">列出 sessions</button>
           <select id="tmuxWindowSelect" title="选择 tmux 目标（session:window.pane）" style="display:none"><option value="">正在列出...</option></select>
         </div>
       </div>
       <div id="tmuxListInfo" style="margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--subtle-bg);font-size:12px;line-height:1.4;">
         <span id="tmuxListMeta">等待列出 tmux sessions...</span>
         <div id="tmuxFilterBar" class="tmuxFilterBar"></div>
         <div id="tmuxOverview" class="tmuxOverviewGrid" style="margin-top:6px;display:grid;gap:4px;"></div>
       </div>
       <details open>
         <summary>实时捕获数据（<span id="tmuxCaptureMeta">等待同步</span>）</summary>
         <pre id="tmuxCapturePre" style="max-height:320px;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;">尚未同步，请刷新或等待自动轮询...</pre>
       </details>
      <div id="tmuxInstructions" style="display:grid;gap:6px;margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--subtle-bg);">
        <b style="font-size:12px;">可复制的 tmux 附着指令（当嵌入 xterm 异常时手动打开）</b>
        <div style="display:grid;gap:4px;font-family:Consolas,monospace;font-size:11px;">
          <div>Agent 附着会话：<code id="tmuxCmdAgent">ssh &lt;user&gt;@&lt;host&gt; -t "tmux attach -t zlk-worker-&lt;id&gt;-agent"</code> <button class="secondary" type="button" data-copy-target="tmuxCmdAgent">复制</button></div>
          <div>调度显示会话：<code id="tmuxCmdSch">tmux attach -t zlk-sch-&lt;opId&gt;</code> <button class="secondary" type="button" data-copy-target="tmuxCmdSch">复制</button></div>
          <div>GPU 窗口：<code id="tmuxCmdGpu">tmux attach -t simple-gpu-0</code> <button class="secondary" type="button" data-copy-target="tmuxCmdGpu">复制</button> <code>simple-gpu-0..3</code></div>
        </div>
      </div>
    </section>`;
  }
  renderCss(): string {
    return `
    .tmuxOverviewGrid { display: grid; gap: 6px; }
    .tmuxFilterBar { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 6px; }
`;
  }
  renderScript(): string {
    return `
function renderTmux(state){
  var el=document.querySelector('[data-section="tmux"]');
  if(!el) return;
}
`;
  }
}
export const tmuxSection = new TmuxSection();
export default TmuxSection;
