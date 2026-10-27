import { MacReleaseClient } from "../platform/MacReleaseClient";
import { ComponentUpdate, PluginUpdatePlan, planPairedUpdates, componentUpdateForInstalledVersion,
  EXPERIMENT_EXTENSION_ID, SFTP_EXTENSION_ID, EXPERIMENT_UPDATE_REPO, SFTP_UPDATE_REPO, normalizeReleaseVersion, compareSemanticVersions } from "../features/ExtensionUpdates";
import { ReleaseClient, RateLimitedError, assertUpdateUrl } from "./ReleaseClient";
import { PackageStore } from "./VerifiedPackage";
import { UpdateGate } from "./UpdateGate";
import { UpdateJournal, UpdateTransaction, TRANSACTION_KEY } from "./UpdateTransaction";
import * as path from "node:path";
import * as fs from "node:fs";
import { defaultHostOperationLeasePath } from "../core/HostOperationLease";

export const CHECK_COMMAND = "simpleExperimentMac.checkPluginUpdates";
export const INSTALL_COMMAND = "simpleExperimentMac.installPluginUpdates";
const STATUS_KEY = "simpleExperimentMac.pluginUpdateStatus";
const RETRY_KEY = "simpleExperimentMac.pluginUpdateRetryAt";
let service: ReturnType<typeof registerUpdater> | undefined;
let status: PluginUpdatePlan = { status: "unknown", message: "尚未检查配套更新。", checkedAt: "" };
let business: any;
export function getUpdater() { return service; }
export function getUpdateStatus() { return structuredClone(status); }
export function assertBusinessAllowed(): void {
  if (service?.blocked) throw new Error("配套插件正在更新或等待补装/重载，暂不接受新的本机业务操作；远端训练保持运行。");
  try {
    const file = defaultHostOperationLeasePath(), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("本机更新租约身份无效。");
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    if (["paired-plugin-update", "mac-preview-update"].includes(row.actionType) && Date.parse(row.expiresAt) > Date.now()) throw new Error("另一窗口正在配套更新；暂不接受新的本机业务操作。");
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
}

export function validateUpdateComponents(components: ComponentUpdate[]): void {
  const ids = [SFTP_EXTENSION_ID, EXPERIMENT_EXTENSION_ID], repos = [SFTP_UPDATE_REPO, EXPERIMENT_UPDATE_REPO];
  if (!Array.isArray(components) || components.length !== 2) throw new Error("配套更新记录无效。");
  for (let i = 0; i < 2; i++) {
    const c = components[i], a = c?.vsix;
    if (c?.id !== ids[i] || c.repo !== repos[i] || !c.latestVersion || normalizeReleaseVersion(c.latestVersion) !== c.latestVersion || !a || !Number.isSafeInteger(a.size) || a.size < 22 || a.size > 128 * 1024 * 1024
      || !/^sha256:[a-f0-9]{64}$/i.test(a.digest || "")) throw new Error("配套更新记录的身份、大小或 SHA-256 无效。");
    assertUpdateUrl(a.url, c.repo);
    componentUpdateForInstalledVersion(c, "0.0.0");
  }
}

/** Independent update entry: no project, tunnel or business panel is needed. */
export function registerUpdater(context: any, vscode: any, client?: ReleaseClient, options: any = {}) {
  const current = (id: string) => String(vscode.extensions.getExtension(id)?.packageJSON?.version || "0.0.0");
  // Proven rate-limit backoff lives in globalState so a window reload cannot immediately
  // re-hammer the GitHub API; the store's async save is awaited inside the client.
  const retryStore = {
    load: async () => Number(context.globalState.get(RETRY_KEY, 0)) || 0,
    save: async (at: number) => { await context.globalState.update(RETRY_KEY, at); },
  };
  const releaseClient = client || new MacReleaseClient(vscode.version, retryStore);
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  bar.command = CHECK_COMMAND; bar.show();
  status = { status: "unknown", message: "尚未检查配套更新。", checkedAt: "" };
  const initialJournal: UpdateJournal | undefined = context.globalState.get(TRANSACTION_KEY);
  let blocked = Boolean(initialJournal && (initialJournal.installationRequested || initialJournal.completed?.length || ["installing", "reload_required"].includes(initialJournal.status)));
  let gateActive = false, disposed = false, lastPlan: PluginUpdatePlan | undefined;
  let checking: Promise<PluginUpdatePlan> | undefined, installing: Promise<any> | undefined;
  const notices = new Set<string>();
  const gate = options.gate || new UpdateGate();
  const store = options.store || new PackageStore(path.join(context.globalStorageUri.fsPath, "updates", "verified"), releaseClient, vscode.version);
  async function acquireGate() {
    if (compareSemanticVersions(current(SFTP_EXTENSION_ID), "0.2.102") < 0) throw new Error("此对齐源码的配套更新需要采用共同等待协议的 SimpleSFTP Mac 0.2.102 或以上；请等待已有传输完成后先安装配套包并重载，不能中断旧版传输。");
    await gate.begin(context.globalStorageUri.fsPath); gateActive = true; blocked = true;
  }
  async function publish(value: PluginUpdatePlan) {
    if (disposed) return;
    status = structuredClone(value);
    bar.text = `$(cloud-download) 配套更新：${({ unknown: "未检查", checking: "检查中", up_to_date: "已是最新", update_available: "可更新", installing: "更新中", reload_required: "需重载", error: "失败" })[value.status]}`;
    bar.tooltip = value.message;
    await context.globalState.update(STATUS_KEY, status);
    try { require.cache[require.resolve("../extension/Activation")]?.exports.getProvider()?.postState?.(); } catch { /* Do not load business to report an update. */ }
  }
  const transaction = new UpdateTransaction({
    readJournal: () => context.globalState.get(TRANSACTION_KEY),
    saveJournal: async (value: UpdateJournal) => { await context.globalState.update(TRANSACTION_KEY, value); },
    currentVersion: current,
    beginGate: async () => {
      await acquireGate();
      await publish({ ...status, status: "installing", message: "等待本地操作完成；现有传输继续，远端训练保持运行。" });
    },
    waitForTransfers: async signal => gate.wait(signal),
    endGate: async () => { await gate.end(); gateActive = false; blocked = false; },
    prepare: async component => { await publish({ ...status, status: "installing", message: `下载并验证 ${component.label} ${component.latestVersion}。` }); return store.prepare(component); },
    verify: async (file, component) => store.verify(file, component),
    install: async file => { await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file)); },
    reload: async () => { await publish({ ...status, status: "reload_required", message: "配套更新已安装，需要重载窗口生效。" }); await vscode.commands.executeCommand("workbench.action.reloadWindow"); },
  });
  async function checkCore(manual: boolean): Promise<PluginUpdatePlan> {
    if (installing) return status;
    await publish({ ...status, status: "checking", message: "正在检查 Mac 配套插件公开 preview Release。" });
    try {
      const journal: UpdateJournal | undefined = context.globalState.get(TRANSACTION_KEY);
      if (journal && ["failed", "installing", "reload_required"].includes(journal.status)) {
        validateUpdateComponents(journal.components);
        const frozen = planPairedUpdates(componentUpdateForInstalledVersion(journal.components[1], current(EXPERIMENT_EXTENSION_ID)),
          componentUpdateForInstalledVersion(journal.components[0], current(SFTP_EXTENSION_ID)));
        if (frozen.status === "update_available") {
          lastPlan = frozen;
          if (journal.installationRequested || journal.completed.length || journal.status !== "failed") await acquireGate();
          await publish({ ...frozen, message: "上次配套更新未完成；点击安装补齐原批次，随后重载。" });
          return status;
        }
        if (gateActive) { await publish({ ...frozen, status: "reload_required", message: "更新组件已安装，请重载窗口后继续。" }); return status; }
        // A new Extension Host sees the installed disk versions after reload.
        await context.globalState.update(TRANSACTION_KEY, undefined);
        blocked = false;
      }
      lastPlan = await releaseClient.check(current, manual); await publish(lastPlan);
      const key = `simpleExperimentMac.update.notified.${lastPlan.sftp?.latestVersion}:${lastPlan.experiment?.latestVersion}`;
      if (lastPlan.status === "update_available" && !notices.has(key) && !context.globalState.get(key, false)) {
        notices.add(key); await context.globalState.update(key, true);
        const choice = await vscode.window.showInformationMessage(lastPlan.message, "查看更新");
        if (choice === "查看更新") void vscode.window.showInformationMessage(lastPlan.message + " 可通过命令面板“安装或补装配套更新并重载”操作。");
      } else if (manual) void vscode.window.showInformationMessage(lastPlan.message);
      return status;
    } catch (error: any) {
      if (error instanceof RateLimitedError) {
        // A proven quota window is a deferral, not a check failure. Publish the existing
        // unknown state with an explicit deferred message (never leave the API/panel/
        // globalState stuck on "checking", never relabel stale data as latest).
        const when = new Date(error.retryAt).toLocaleString();
        const deferred = `GitHub API 限流中；更新检查已延后，${when} 后自动重试；此前的检查结果不能视为最新。`;
        await publish({ ...status, status: "unknown", message: deferred });
        bar.text = "$(cloud) 配套更新：限流中";
        bar.tooltip = deferred;
        if (manual) void vscode.window.showWarningMessage(deferred);
        return status;
      }
      await publish({ ...status, status: "error", message: `检查失败：${error.message}` });
      if (manual) void vscode.window.showErrorMessage(status.message);
      throw error;
    }
  }
  function check(manual = false): Promise<PluginUpdatePlan> {
    if (checking) return checking;
    checking = checkCore(manual).finally(() => { checking = undefined; }); return checking;
  }
  async function installCore() {
    if (!lastPlan) await check(true);
    const journal: UpdateJournal | undefined = context.globalState.get(TRANSACTION_KEY);
    const components = journal && ["failed", "installing", "reload_required"].includes(journal.status) ? journal.components : [lastPlan!.sftp!, lastPlan!.experiment!];
    validateUpdateComponents(components);
    const plan = planPairedUpdates(componentUpdateForInstalledVersion(components[1], current(EXPERIMENT_EXTENSION_ID)), componentUpdateForInstalledVersion(components[0], current(SFTP_EXTENSION_ID)));
    if (plan.status !== "update_available") { await publish(plan); return plan; }
    const detail = components.map(c => `${c.label} ${current(c.id)} → ${c.latestVersion}\n${c.vsix!.url}\nSHA256 ${c.vsix!.digest!.slice(7)}`).join("\n\n");
    const answer = await vscode.window.showWarningMessage(`安装并重载窗口以应用配套插件更新？\n\n${detail}`, { modal: true }, "安装并重载", "取消");
    if (answer !== "安装并重载") return plan;
    const controller = new AbortController();
    try {
      if (vscode.window.withProgress) return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "配套插件更新", cancellable: true }, async (_: any, cancellation: any) => {
        const subscription = cancellation.onCancellationRequested(() => controller.abort(new Error("用户取消更新；已安装组件需重载核对。")));
        try { return await transaction.install(components, controller.signal); } finally { subscription.dispose(); }
      });
      return await transaction.install(components, controller.signal);
    } catch (error: any) {
      await publish({ ...status, status: "error", message: error.message });
      const answer = await vscode.window.showErrorMessage(error.message, ...(blocked ? ["重载后补装"] : []));
      if (answer === "重载后补装") await vscode.commands.executeCommand("workbench.action.reloadWindow");
      throw error;
    }
  }
  function install(): Promise<any> {
    if (installing) return installing;
    installing = installCore().finally(() => { installing = undefined; }); return installing;
  }
  const timer = setInterval(() => { if (!blocked && !installing) void check(false).catch(() => undefined); }, 30 * 60 * 1000); timer.unref?.();
  context.subscriptions.push(bar, vscode.commands.registerCommand(CHECK_COMMAND, () => check(true)), vscode.commands.registerCommand(INSTALL_COMMAND, install),
    { dispose() { disposed = true; clearInterval(timer); } });
  return { check, install, dispose: () => gate.end(), get blocked() { return blocked; } };
}

export async function activateWithBusiness(context: any, vscode: any, loadBusiness: () => any, client?: ReleaseClient, options?: any): Promise<void> {
  service = registerUpdater(context, vscode, client, options);
  void service.check(false).catch(() => undefined);
  try { business = loadBusiness(); await business.activate(context); }
  catch (error: any) { void vscode.window.showErrorMessage(`业务面板启动失败，独立更新命令仍可用：${error.message}`); }
}
export async function activate(context: any): Promise<void> { await activateWithBusiness(context, require("vscode"), () => require("../extension")); }
export async function deactivate(): Promise<void> { try { await business?.deactivate?.(); } finally { await service?.dispose(); service = undefined; } }
