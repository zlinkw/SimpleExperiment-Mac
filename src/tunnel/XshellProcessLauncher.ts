import { spawn } from "child_process";
import { buildXshellTunnelCommand } from "./XshellTunnelCommandBuilder";
import { XshellRealtimeTunnelConfig } from "./XshellTunnelSetup";

export interface XshellLaunchResult {
  attempted: boolean;
  launched: boolean;
  pid?: number;
  commandPreview: string;
  message: string;
  error?: string;
}

export async function launchXshellTunnelProcess(config: XshellRealtimeTunnelConfig): Promise<XshellLaunchResult> {
  const preview = buildXshellTunnelCommand(config);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(config.xshellExePath, preview.args, {
      detached: false,
      windowsHide: false,
      stdio: "ignore",
    });
    const settle = (result: XshellLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({
      attempted: true,
      launched: false,
      commandPreview: preview.redactedShellCommand,
      message: "Xshell 会话启动失败。",
      error: error.message,
    }));
    setTimeout(() => settle({
      attempted: true,
      launched: true,
      pid: child.pid,
      commandPreview: preview.redactedShellCommand,
      message: "Xshell 会话启动命令已发出，请通过本地隧道检测确认是否可用。",
    }), 300).unref?.();
  });
}
