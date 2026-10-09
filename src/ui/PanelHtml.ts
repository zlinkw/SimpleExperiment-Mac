/**
 * src/ui/PanelHtml.ts - Facade (Factory Refactor v0.4.92) - HOTFIX
 * 紧急回退：直接委托 legacy，确保握手 JS 完整
 * 工厂路径仅在显式开启时使用，待 JS 补全后再切回
 */
export function renderPanelHtml(): string {
  let factoryFailure = "";
  let legacyFailure = "";
  // 工厂灰度开关：仅当环境变量或全局标记显式开启时走工厂，否则直接 legacy
  try {
    const useFactory = (typeof process !== "undefined" && process.env && process.env.FEATURE_FACTORY_PANEL === "1")
      || (typeof (globalThis as any).__panelFactoryOptIn !== "undefined" && String((globalThis as any).__panelFactoryOptIn) === "1");
    if (useFactory) {
      const { DefaultPanelSectionFactory } = require("../factories/PanelSectionFactory");
      const { PanelHtmlRenderer } = require("./PanelHtmlRenderer");
      const { PanelTemplateEscaper } = require("./PanelTemplateEscaper");
      const factory = new DefaultPanelSectionFactory();
      const sections = factory.createAll({} as any);
      const escaper = new PanelTemplateEscaper();
      const renderer = new PanelHtmlRenderer(sections as any, escaper);
      const html = renderer.render(String(Date.now()));
      // 功能门禁：必须含握手三件套才视为可用，否则回退
      if (html && html.includes("acquireVsCodeApi") && html.includes("requestInitialPanelState") && html.includes("handleIncomingWebviewMessage")) {
        // 额外 vm 校验
        new (require("vm").Script)(renderer.renderScript());
        return html;
      }
    }
  } catch (e) {
    factoryFailure = String((e as Error)?.message || e).slice(0, 400);
    try { console.error("[PanelHtml facade] factory failed, fallback to legacy", e); } catch {}
  }
  // 默认回退 legacy - 保证 958k 完整 HTML + 831k JS + 握手
  try {
    const legacy = require("./PanelHtml.legacy");
    if (legacy && typeof legacy.renderPanelHtml === "function") {
      return legacy.renderPanelHtml();
    }
  } catch (e) {
    legacyFailure = String((e as Error)?.message || e).slice(0, 400);
    try { console.error("[PanelHtml facade] legacy failed", e); } catch {}
  }
  const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char));
  const details = [factoryFailure && `模块面板：${factoryFailure}`, legacyFailure && `兼容面板：${legacyFailure}`]
    .filter((value): value is string => Boolean(value)).map(esc).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>SimpleExperiment 面板恢复</title><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:20px;line-height:1.6}.card{max-width:680px;margin:5vh auto;padding:18px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-background)}h1{font-size:18px}p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;color:var(--vscode-errorForeground);font-size:12px}</style></head><body><main class="card" role="alert"><h1>SimpleExperiment 面板资源加载失败</h1><p>扩展 Host 仍可使用。请从命令面板运行“SimpleExperiment: 恢复 Panel”或“SimpleExperiment: 复制 Panel 诊断”，并检查扩展宿主日志。</p>${details ? `<pre>${details}</pre>` : ""}</main></body></html>`;
}
