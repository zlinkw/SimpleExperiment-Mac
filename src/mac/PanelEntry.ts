import * as path from "node:path";

const entries = new WeakMap<object, MacPanelEntry>();
const COMMAND = "simpleExperimentMac.openPanel";
const VIEW = "simpleExperimentMac.panel";
const loadedPackage = require("../../package.json");

export interface MacPanelEntry {
  bindContext(context: object): void;
  ready(provider: any): void;
  fail(stage: string, error: unknown): void;
  ownsCommand(command: string): boolean;
  dispose(): void;
}

export function panelEntryFor(context: object): MacPanelEntry | undefined {
  return entries.get(context);
}

/** Register the existing Mac navigation entry before importing business modules. */
export function registerMacPanelEntry(context: any, vscode: any): MacPanelEntry {
  const output = vscode.window.createOutputChannel("SimpleExperiment Startup");
  const id = `${loadedPackage.publisher}.${loadedPackage.name}`;
  const registered = vscode.extensions.getExtension(id);
  const sftp = vscode.extensions.getExtension("simple-local.simple-sftp-mac");
  const identity = [
    `Loaded extension: ${id} ${loadedPackage.version}`,
    `Loaded code: ${path.resolve(__dirname, "../..")}`,
    `Context path: ${context.extensionPath || context.extensionUri?.fsPath || ""}`,
    `Registry: ${registered?.packageJSON?.version || "unknown"} ${registered?.extensionPath || ""}`,
    `SFTP dependency: ${sftp?.packageJSON?.version || "not found"} ${sftp?.extensionPath || ""}; active=${sftp?.isActive === true}`,
    `Host process: ${process.platform}/${process.arch}; VS Code: ${vscode.version}`,
    `Workspace remote type: ${vscode.env?.remoteName || "local"}`,
  ].join("\n");
  output.appendLine(identity);
  let provider: any, view: any, failure = "", disposed = false;
  const contexts: object[] = [];
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function showStartup(): void {
    if (!view || disposed) return;
    view.webview.options = { enableScripts: false };
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{padding:20px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h2>SimpleExperiment ${failure ? "启动失败" : "正在启动"}</h2><p>${failure ? "请保留下面的首条异常和加载身份；无需清空配置或重建项目。完整日志见“输出 → SimpleExperiment Startup”。" : "桌面面板入口已就绪，正在初始化本机插件。服务器尚未连接也可以打开此页面。"}</p><pre>${escape(identity + (failure ? "\n\n" + failure : ""))}</pre></body></html>`;
  }
  function resolveBusiness(): void {
    if (!view || disposed) return;
    if (!provider) { showStartup(); return; }
    try { provider.resolveWebviewView(view); }
    catch (error) { entry.fail("resolveWebviewView", error); showStartup(); }
  }
  const entry: MacPanelEntry = {
    bindContext(value) { contexts.push(value); entries.set(value, entry); },
    ready(value) { provider = value; output.appendLine("Business Provider ready."); resolveBusiness(); },
    fail(stage, error: any) {
      if (disposed) return;
      const detail = `[${stage}] ${String(error?.stack || error?.message || error)}`;
      if (!failure) failure = detail;
      output.appendLine(detail);
      console.error(`[SimpleExperiment Startup] ${stage}`, error);
      if (!provider) showStartup();
    },
    ownsCommand(command) { return !disposed && command === COMMAND; },
    dispose() { disposed = true; for (const value of contexts) entries.delete(value); provider = undefined; view = undefined; },
  };
  entry.bindContext(context);
  context.subscriptions.push(entry, output);
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND, async () => {
      if (provider) return provider.openPanel();
      return vscode.commands.executeCommand(`${VIEW}.focus`);
    }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW, {
      resolveWebviewView(value: any) { view = value; resolveBusiness(); },
    }, { webviewOptions: { retainContextWhenHidden: vscode.workspace.getConfiguration("simpleExperimentMac").get("panel.retainContextWhenHidden", false) === true } }));
  return entry;
}
