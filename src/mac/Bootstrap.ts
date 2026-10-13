import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PreviewReleaseClient, PreviewPlan, parseManifest, planPreview } from "./PreviewRelease";
import { UpdateTransaction, TRANSACTION_KEY, UpdateJournal, updateJournalNeedsRecovery } from "./UpdateTransaction";
import { verifyVsix, ReleaseComponent } from "./Vsix";
import { beginUpdateGate, endUpdateGate, waitForLocalOperations, assertCompatibleSftpForUpdate, setLocalUpdateBlocked, updateGateHeld } from "./UpdateGate";
import { registerMacCli } from "./CliLauncher";

export const CHECK_COMMAND = "simpleExperimentMac.checkPreviewUpdates";
export const INSTALL_COMMAND = "simpleExperimentMac.installPreviewUpdates";
let business: any;
let updater: ReturnType<typeof registerPreviewUpdater> | undefined;
let updateStatus: any = { status: "unknown", message: "preview 更新尚未检查" };
export function getUpdateStatus() { return { ...updateStatus }; }

export function registerPreviewUpdater(context: any, vscode: any, client: Pick<PreviewReleaseClient, "check" | "download"> = new PreviewReleaseClient()) {
  const current = (id: string) => vscode.extensions.getExtension(id)?.packageJSON?.version || "0.0.0";
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  bar.command = CHECK_COMMAND; bar.show();
  const status = (value: any) => { updateStatus = value; bar.text = `$(cloud-download) Mac preview：${value.message}`; };
  status(updateStatus);
  let lastPlan: PreviewPlan | undefined;
  let installing: Promise<any> | undefined;
  setLocalUpdateBlocked(updateJournalNeedsRecovery(context.globalState.get(TRANSACTION_KEY)));
  const notices = new Set<string>();
  const sf = () => vscode.extensions.getExtension("simple-local.simple-sftp-mac");
  const transaction = new UpdateTransaction({
    readJournal: () => context.globalState.get(TRANSACTION_KEY),
    saveJournal: async value => { await context.globalState.update(TRANSACTION_KEY, value); },
    currentVersion: current,
    beginGate: async () => {
      if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("仅 Apple Silicon Mac 可安装 preview 更新");
      assertCompatibleSftpForUpdate(current("simple-local.simple-sftp-mac"));
      await beginUpdateGate(context.globalStorageUri.fsPath); sf()?.exports?.setUpdateGate?.(true); status({ status: "installing", message: "等待本地传输完成" });
    },
    waitForTransfers: async signal => { await sf()?.exports?.waitForUpdateIdle?.({ signal }); await waitForLocalOperations(signal); },
    endGate: async () => { sf()?.exports?.setUpdateGate?.(false); await endUpdateGate(); },
    downloadAndVerify: async component => {
      status({ status: "installing", message: `验证 ${component.extensionId} ${component.version}` });
      const bytes = await client.download(component, vscode.version);
      const directory = path.join(context.globalStorageUri.fsPath, "preview-updates"); await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `${randomUUID()}.vsix`);
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      return file;
    },
    verifyPrepared: async (file: string, component: ReleaseComponent) => {
      const root = await fs.realpath(path.join(context.globalStorageUri.fsPath, "preview-updates"));
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(await fs.realpath(file)) !== root) throw new Error("更新包路径身份发生变化");
      verifyVsix(await fs.readFile(file), component, vscode.version);
    },
    install: async file => { await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file)); },
    reload: async () => { status({ status: "reload_required", message: "更新完成，重载窗口" }); await vscode.commands.executeCommand("workbench.action.reloadWindow"); },
  });
  async function recoverPlan(): Promise<PreviewPlan | undefined> {
    const journal: UpdateJournal | undefined = context.globalState.get(TRANSACTION_KEY);
    if (!journal || !["failed", "installing", "reload_required"].includes(journal.status)) return;
    const assets = journal.manifest.components.map(item => ({ name: item.downloadUrl.split("/").at(-1), browser_download_url: item.downloadUrl, size: item.size }));
    const manifest = parseManifest(journal.manifest, { tag_name: journal.manifest.releaseTag, assets }, vscode.version);
    const plan = planPreview(manifest, current);
    if (!plan.pending.length && !updateGateHeld()) {
      await context.globalState.update(TRANSACTION_KEY, undefined); setLocalUpdateBlocked(false); return;
    }
    if (updateJournalNeedsRecovery(journal)) {
      setLocalUpdateBlocked(true); assertCompatibleSftpForUpdate(current("simple-local.simple-sftp-mac"));
      await beginUpdateGate(context.globalStorageUri.fsPath); sf()?.exports?.setUpdateGate?.(true);
    }
    return plan;
  }
  async function installCore(plan?: PreviewPlan) {
    const controller = new AbortController();
    try {
      lastPlan = await recoverPlan() || plan || lastPlan || await client.check(vscode.version, current, true);
      if (vscode.window.withProgress) return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Mac preview 配套更新", cancellable: true }, async (_progress: any, cancellation: any) => {
        const subscription = cancellation.onCancellationRequested(() => controller.abort(new Error("已取消配套更新等待，现有传输继续运行；若已请求安装，请重载后核对并补装原批次。")));
        try { return await transaction.install(lastPlan!, controller.signal); } finally { subscription.dispose(); }
      });
      return await transaction.install(lastPlan, controller.signal);
    }
    catch (error: any) {
      status({ ...updateStatus, status: "error", message: error.message });
      const action = await vscode.window.showErrorMessage(error.message, ...(updateJournalNeedsRecovery(error.journal) ? ["重载后补装"] : []));
      if (action === "重载后补装") await vscode.commands.executeCommand("workbench.action.reloadWindow");
      throw error;
    }
  }
  function install(plan?: PreviewPlan) {
    if (installing) return installing;
    installing = installCore(plan).finally(() => { installing = undefined; }); return installing;
  }
  async function check(manual = false) {
    if (installing && lastPlan) return lastPlan;
    status({ status: "checking", message: "正在检查" });
    try {
      const recovery = await recoverPlan();
      lastPlan = recovery || await client.check(vscode.version, current, manual);
      const versions = lastPlan.manifest.components.map(item => `${item.extensionId} ${item.version}`).join("，");
      const describe = (id: string, label: string) => {
        const component = lastPlan!.manifest.components.find(item => item.extensionId === id)!;
        return { extensionId: id, label, currentVersion: current(id), latestVersion: component.version, updateAvailable: lastPlan!.pending.some(item => item.extensionId === id) };
      };
      status({ status: recovery && !lastPlan.pending.length ? "reload_required" : lastPlan.pending.length ? "update_available" : "up_to_date", message: recovery ? "上次更新批次需要补装或重载；点击安装 preview 配套更新处理原批次" : lastPlan.pending.length ? "有可用 preview 配套更新" : "已是最新", checkedAt: new Date().toISOString(), plan: lastPlan,
        sftp: describe("simple-local.simple-sftp-mac", "SimpleSFTP Mac"), experiment: describe("simple-local.simple-experiment-mac", "SimpleExperiment Mac") });
      const key = "simpleExperimentMac.preview.notified." + lastPlan.manifest.releaseTag;
      if (lastPlan.pending.length && !notices.has(key) && !context.globalState.get(key, false)) {
        notices.add(key);
        await context.globalState.update(key, true);
        const answer = await vscode.window.showInformationMessage(`配套 preview 更新：${versions}`, "更新并重载");
        if (answer === "更新并重载") await install(lastPlan);
      } else if (manual) await vscode.window.showInformationMessage(lastPlan.pending.length ? `可用更新：${versions}。运行“安装 preview 配套更新”。` : `已是最新：${versions}`);
      return lastPlan;
    } catch (error: any) {
      status({ status: "error", message: `检查失败：${error.message}` });
      if (manual) await vscode.window.showErrorMessage(updateStatus.message);
      throw error;
    }
  }
  async function resume() {
    await check(false);
  }
  const timer = setInterval(() => { void check(false).catch(() => undefined); }, 30 * 60 * 1000); timer.unref?.();
  context.subscriptions.push(bar, vscode.commands.registerCommand(CHECK_COMMAND, () => check(true)), vscode.commands.registerCommand(INSTALL_COMMAND, () => install()), { dispose() { clearInterval(timer); } });
  return { check, install, resume };
}

export async function activate(context: any): Promise<void> {
  const vscode = require("vscode");
  // This entry does not import the panel or require any server configuration.
  updater = registerPreviewUpdater(context, vscode);
  const cli = registerMacCli(context, vscode);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    await vscode.window.showWarningMessage("SimpleExperiment Mac preview 仅支持 Apple Silicon、macOS 26 及以上。");
    return;
  }
  const osVersion = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (osVersion.status !== 0 || Number(osVersion.stdout.trim().split(".")[0]) < 26) {
    await vscode.window.showErrorMessage("SimpleExperiment Mac preview 需要 macOS 26 及以上。"); return;
  }
  void updater.resume().catch(() => undefined);
  try { cli.refresh(); }
  catch (error: any) { void vscode.window.showWarningMessage(`Mac CLI 入口暂不可用：${error.message}。独立更新入口保留。`); }
  try { business = require("../extension"); await business.activate(context); }
  catch (error: any) { await vscode.window.showErrorMessage(`业务面板启动失败，独立更新入口仍可用：${error.message}`); }
}
export async function deactivate(): Promise<void> { await business?.deactivate?.(); await endUpdateGate(); }
