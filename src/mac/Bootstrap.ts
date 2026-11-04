import { spawnSync } from "node:child_process";
import { registerMacPanelEntry } from "./PanelEntry";

export const CHECK_COMMAND = "simpleExperimentMac.checkPreviewUpdates";
export const INSTALL_COMMAND = "simpleExperimentMac.installPreviewUpdates";
let shared: typeof import("../updates/Bootstrap") | undefined;
let scheduled: ReturnType<typeof setImmediate> | undefined;
export const getPreviewUpdater = () => require("../updates/Bootstrap").getUpdater();
export const getUpdateStatus = () => require("../updates/Bootstrap").getUpdateStatus();
export const registerPreviewUpdater = (...args: any[]) => require("../updates/Bootstrap").registerUpdater(...args);

/** OS entry only; Windows owns checks, transactions and business admission. */
export async function activate(context: any): Promise<void> {
  const vscode = require("vscode"), entry = registerMacPanelEntry(context, vscode);
  scheduled = setImmediate(() => {
    scheduled = undefined;
    void (async () => {
      shared = require("../updates/Bootstrap");
      const { macUpdateContext, MacReleaseClient } = require("../platform/MacReleaseClient");
      const updates = shared!;
      const businessContext = macUpdateContext(context, vscode.version);
      entry.bindContext(businessContext);
      context.subscriptions.push(
        vscode.commands.registerCommand(CHECK_COMMAND, () => vscode.commands.executeCommand(updates.CHECK_COMMAND)),
        vscode.commands.registerCommand(INSTALL_COMMAND, () => vscode.commands.executeCommand(updates.INSTALL_COMMAND)));
      await updates.activateWithBusiness(businessContext, vscode, () => {
        const { registerMacCli } = require("./CliLauncher"), cli = registerMacCli(context, vscode);
        let supported = process.platform === "darwin" && process.arch === "arm64";
        if (supported) {
          const version = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 10000, windowsHide: true });
          supported = version.status === 0 && Number(version.stdout.trim().split(".")[0]) >= 26;
        }
        if (!supported) throw new Error("SimpleExperiment Mac 需要 Apple Silicon、macOS 26 及以上。");
        try { cli.refresh(); } catch (error: any) { void vscode.window.showWarningMessage(`Mac CLI 入口暂不可用：${error.message}`); }
        return require("../extension");
      }, new MacReleaseClient(vscode.version));
    })().catch(error => entry.fail("bootstrap", error));
  });
  context.subscriptions.push({ dispose() { if (scheduled) clearImmediate(scheduled); scheduled = undefined; } });
}
export async function deactivate(): Promise<void> {
  if (scheduled) clearImmediate(scheduled);
  scheduled = undefined;
  await shared?.deactivate();
  shared = undefined;
}
