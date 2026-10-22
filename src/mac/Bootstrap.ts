import { spawnSync } from "node:child_process";
import { registerMacCli } from "./CliLauncher";
import * as shared from "../updates/Bootstrap";
import { macUpdateContext, MacReleaseClient } from "../platform/MacReleaseClient";

export const CHECK_COMMAND = "simpleExperimentMac.checkPreviewUpdates";
export const INSTALL_COMMAND = "simpleExperimentMac.installPreviewUpdates";
export const getPreviewUpdater = shared.getUpdater;
export const getUpdateStatus = shared.getUpdateStatus;
export const registerPreviewUpdater = shared.registerUpdater;

/** OS entry only; Windows owns checks, transactions and business admission. */
export async function activate(context: any): Promise<void> {
  const vscode = require("vscode"), cli = registerMacCli(context, vscode);
  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_COMMAND, () => vscode.commands.executeCommand(shared.CHECK_COMMAND)),
    vscode.commands.registerCommand(INSTALL_COMMAND, () => vscode.commands.executeCommand(shared.INSTALL_COMMAND)));
  const compatible = process.platform === "darwin" && process.arch === "arm64";
  let supported = compatible;
  if (compatible) {
    const version = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    supported = version.status === 0 && Number(version.stdout.trim().split(".")[0]) >= 26;
  }
  await shared.activateWithBusiness(macUpdateContext(context, vscode.version), vscode, () => {
    if (!supported) throw new Error("SimpleExperiment Mac 需要 Apple Silicon、macOS 26 及以上。");
    try { cli.refresh(); } catch (error: any) { void vscode.window.showWarningMessage(`Mac CLI 入口暂不可用：${error.message}`); }
    return require("../extension");
  }, new MacReleaseClient(vscode.version));
}
export const deactivate = shared.deactivate;
