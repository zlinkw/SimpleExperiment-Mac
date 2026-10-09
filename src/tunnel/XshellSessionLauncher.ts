import { spawn } from "child_process";
import * as path from "path";

export interface XshellSavedSessionLaunchRequest {
  exePath: string;
  sessionPath: string;
  displayName?: string;
}

export interface XshellSavedSessionLaunchResult {
  attempted: boolean;
  launched: boolean;
  pid?: number;
  commandPreview: string;
  message: string;
  error?: string;
}

export function buildXshellSavedSessionPreview(request: XshellSavedSessionLaunchRequest): string {
  validateXshellSavedSessionRequest(request);
  return [windowsQuote(request.exePath), windowsQuote(request.sessionPath)].join(" ");
}

export async function launchXshellSavedSession(request: XshellSavedSessionLaunchRequest): Promise<XshellSavedSessionLaunchResult> {
  const commandPreview = buildXshellSavedSessionPreview(request);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(request.exePath, [request.sessionPath], {
      detached: false,
      windowsHide: false,
      stdio: "ignore",
    });
    const settle = (result: XshellSavedSessionLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({
      attempted: true,
      launched: false,
      commandPreview,
      message: `${request.displayName || "Xshell"} 会话启动失败。`,
      error: error.message,
    }));
    setTimeout(() => settle({
      attempted: true,
      launched: true,
      pid: child.pid,
      commandPreview,
      message: `${request.displayName || "Xshell"} 会话启动命令已发出。`,
    }), 300).unref?.();
  });
}

function validateXshellSavedSessionRequest(request: XshellSavedSessionLaunchRequest): void {
  if (path.basename(request.exePath || "").toLowerCase() !== "xshell.exe") throw new Error("需要配置 Xshell.exe。");
  if (!request.sessionPath?.trim()) throw new Error("需要选择 Xshell .xsh 会话文件。");
}

function windowsQuote(value: string): string {
  return /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}