import type { Section } from "./types";

/**
 * SettingsSection - 设置板块
 * 提取自 PanelHtml.ts 1224-1253 section[data-section="settings"]
 */
export class SettingsSection implements Section {
  readonly id = "settings";
  readonly title = "设置";
  readonly order = 8;
  renderHtml(_state?: unknown): string {
    return `
    <section class="section-card" data-section="settings" data-anchor="settings" data-title="设置">
      <div class="section-head">
        <div class="section-title">
          <h2>设置</h2>
          <div class="section-desc">结果目录、服务器、隧道与调度参数</div>
        </div>
        <div class="cardTools">
          <button type="button" class="secondary settingsBackButton" data-main-view="workspace" title="关闭设置，返回主界面">关闭设置</button>
        </div>
      </div>
      <div class="settingsLayoutTools" data-anchor="settings-layout">
        <b>界面布局</b>
        <button id="layoutEditToggle" class="secondary" type="button">管理布局</button>
        <button id="collapseAllSections" class="secondary" type="button">一键折叠</button>
        <button id="expandAllSections" class="secondary" type="button">一键展开</button>
        <button data-command="resetUiLayout" class="secondary" type="button">恢复默认布局</button>
      </div>
      <div class="settingsCommandTools" data-anchor="settings-advanced-commands">
        <div>
          <b>高级命令</b>
          <span class="muted">默认隐藏旧兼容、诊断和实时流命令</span>
        </div>
        <button data-command="openAdvancedCommandsSetting" class="secondary" type="button">打开命令设置</button>
      </div>
      <div id="remoteRootPolicySettings" data-anchor="settings-remote-root-policy"></div>
      <div id="pluginUpdateSettings" data-anchor="settings-plugin-update"></div>
      <div id="resultCsvDirectorySettings" data-anchor="settings-result-csv"></div>
      <div id="serverChainOverview" data-anchor="settings-chain-overview"></div>
      <div id="serverSettingsCards" data-anchor="settings-servers"></div>
    </section>`;
  }
  renderCss(): string {
    return `
    .settingsLayoutTools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .settingsCommandTools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 6px 0; }
`;
  }
  renderScript(): string {
    return `
function renderSettings(state){
  var el=document.querySelector('[data-section="settings"]');
  if(!el) return;
}
`;
  }
}
export const settingsSection = new SettingsSection();
export default SettingsSection;
