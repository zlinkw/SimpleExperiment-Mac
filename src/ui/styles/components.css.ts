/**
 * components.css - 组件样式：按钮、表单、表格、pills、操作时间线
 * 提取自 PanelHtml.ts ~43-600 行组件段
 */
export const componentsCss = `
    input, select, textarea { min-height: 28px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: var(--radius-sm); padding: 4px 7px; }
    textarea { width: 100%; min-height: 180px; font-family: Consolas, monospace; font-size: 12px; line-height: 1.45; resize: vertical; }
    input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); vertical-align: middle; cursor: pointer; }
    input.wide { width: 100%; box-sizing: border-box; }
    .toolbar, .actionGrid, .summaryLine, .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; align-items: center; min-width: 0; }
    .contractQuickLinks { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
    .syncPublishPanel { display: grid; gap: 8px; min-width: 0; }
    .summaryLink { display: inline-flex; align-items: center; min-width: 0; padding: 6px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--subtle-bg); color: var(--text); text-decoration: none; font-size: 12px; }
    button { max-width: 100%; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-background); padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer; line-height: 1.25; text-align: center; white-space: normal; overflow-wrap: anywhere; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: transparent; border-color: var(--border); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button.is-loading { opacity: .72; cursor: wait; }
    .cardTools { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }
    .pill { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--subtle-bg); font-size: 11px; font-weight: 700; white-space: nowrap; }
    .operationTimeline { display: grid; gap: 6px; }
    .operationItem { position: relative; display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--vscode-editor-background); }
    .operationDot { width: 10px; height: 10px; margin-top: 5px; border-radius: 999px; background: var(--muted); }
    .operationItem.is-running .operationDot { background: var(--info); }
    .operationItem.is-completed .operationDot { background: var(--success); }
    .operationItem.is-failed .operationDot { background: var(--danger); }
    .tree-item { width: 100%; min-height: 30px; display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 7px; padding: 5px 7px; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); text-align: left; font-size: 12px; }
    .tree-item:hover { background: var(--vscode-list-hoverBackground); border-color: var(--border); }
    .tmuxFilterBar { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 6px; margin: 8px 0 6px; }
    .tmuxWindowCard { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 6px; min-height: 42px; padding: 6px 8px; border: 1px solid var(--border); border-left: 4px solid #94A3B8; border-radius: var(--radius-sm); background: var(--vscode-editor-background); }
    .gpuServerStack { display: grid; gap: 10px; }
`;
export default componentsCss;
