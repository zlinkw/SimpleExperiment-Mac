/**
 * base.css - 基础变量与全局样式
 * 提取自 PanelHtml.ts 1-120 行 :root / html / body / h2/h3
 * 通过 PanelTemplateEscaper 转义后由 Renderer 聚合
 */
export const baseCss = `
    :root {
      --app-bg: var(--vscode-editor-background, var(--vscode-sideBar-background));
      --card-bg: color-mix(in srgb, var(--vscode-panel-background, var(--vscode-sideBar-background)) 92%, var(--vscode-editor-foreground) 8%);
      --subtle-bg: color-mix(in srgb, var(--vscode-input-background, var(--vscode-panel-background)) 88%, var(--vscode-editor-foreground) 12%);
      --border: color-mix(in srgb, var(--vscode-input-border, var(--vscode-focusBorder)) 64%, transparent);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --success: var(--vscode-charts-green, #2ea043);
      --info: #037CD5;
      --danger: #f85149;
      --warning: #d29922;
      --gpu-progress-track: rgba(127, 127, 127, .32);
      --gpu-progress-free: #2ea043;
      --gpu-progress-busy: #037CD5;
      --gpu-progress-hot: #d29922;
      --gpu-progress-danger: #f85149;
      --simple-font-xs: 10px;
      --simple-font-sm: 11px;
      --simple-font-md: 12px;
      --simple-font-lg: 13px;
      --simple-font-status: 13px;
      --simple-font-section: 15px;
      --simple-font-title: 18px;
      --radius: 8px;
      --radius-sm: 6px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; padding: 0; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--simple-font-md); line-height: 1.45; color: var(--text); background: #EEF2F7; }
    h2 { margin: 0 0 12px; font-size: var(--simple-font-section); font-weight: 650; }
    h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 600; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; max-height: 240px; overflow: auto; }
    .label, .muted { color: var(--muted); }
    .value, .pathCell { overflow-wrap: anywhere; }
    .row { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px; padding: 4px 0; }
    @keyframes simple-spin { to { transform: rotate(360deg); } }
    .loading-spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 999px; display: inline-block; flex: 0 0 auto; animation: simple-spin .75s linear infinite; }
`;
export default baseCss;
