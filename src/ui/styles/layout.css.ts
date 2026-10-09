/**
 * layout.css - 布局样式：抽屉、网格、卡片、资源树、工作台
 * 提取自 PanelHtml.ts ~57-380 行布局段
 */
export const layoutCss = `
    .app-shell { width: min(100%, 1560px); margin: 0 auto; padding: 22px 24px 30px; display: grid; gap: 16px; }
    .topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; }
    .topbar-actions { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; min-width: 0; }
    .section-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 16px; align-items: start; }
    .section-stack { display: grid; gap: 16px; }
    #cardDeck { display: grid; grid-template-columns: 260px minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
    #cardDeck > [data-section] { grid-column: 2; }
    #cardDeck > [data-section], .mainColumn { grid-column: 3; }
    .mainColumn { grid-column: 2; display: grid; gap: 16px; min-width: 0; }
    .cardGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
    .gpuServerStack { display: grid; grid-template-columns: 1fr; gap: 10px; min-width: 0; width: 100%; box-sizing: border-box; }
    .card, .section-card { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card-bg); display: grid; gap: 12px; }
    .section-card h2, .section-card h3 { margin-top: 0; }
    .section-card { min-width: 0; }
    .section-card.is-collapsed > :not(.section-head) { display: none !important; }
    .resourceTree { grid-column: 1; grid-row: 1 / span 20; position: static; min-height: 0; max-height: none; overflow: visible; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: color-mix(in srgb, var(--vscode-sideBar-background, var(--card-bg)) 94%, var(--vscode-focusBorder) 6%); box-shadow: 0 8px 22px rgba(15, 23, 42, .07); contain: layout paint; }
    .workbenchInspector { grid-column: 3; grid-row: 1 / span 20; position: static; min-height: 0; max-height: none; overflow: auto; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: #FFFFFF; color: #0F172A; box-shadow: 0 8px 22px rgba(15, 23, 42, .07); contain: layout paint; }
    .layoutResizer { width: 8px; cursor: col-resize; background: transparent; }
    .workflowStageRail { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: #F8FAFC; }
    .workflowStage { position: relative; min-width: 0; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; align-items: start; min-height: 74px; padding: 9px; border: 1px solid #CBD5E1; border-left: 4px solid #CBD5E1; border-radius: 8px; background: #FFFFFF; color: #0F172A; }
    .objectStrip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--vscode-sideBar-background, var(--card-bg)) 88%, var(--vscode-editor-background) 12%); }
    .ops-flow { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 8px; margin: 8px 0 0; }
    .onboardingFlow { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 8px; margin: 8px 0; }
    .projectQuickNav { display: grid; gap: 8px; margin: 10px 0; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--card-bg) 94%, var(--vscode-input-background) 6%); }
    .inspectorGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
    @media (max-width: 920px) { #cardDeck { grid-template-columns: 1fr; } .resourceTree, .workbenchInspector { grid-column: 1; grid-row: auto; } }
`;
export default layoutCss;
