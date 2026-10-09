import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import {
  buildXshellArgs,
  buildXshellForwardCommand,
  buildXshellTunnelCommand,
  generateXshellBatScript,
  generateXshellPs1Script,
} from "./XshellTunnelCommandBuilder";
import { launchXshellTunnelProcess } from "./XshellProcessLauncher";
import { XshellTunnelSetupConfig } from "./XshellTunnelSetup";

const commonInstallPaths = [
  "C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe",
  "C:\\Program Files (x86)\\NetSarang\\Xshell 8\\Xshell.exe",
  "C:\\Program Files\\NetSarang\\Xshell 7\\Xshell.exe",
  "C:\\Program Files (x86)\\NetSarang\\Xshell 7\\Xshell.exe",
];

export async function findXshellExecutable(options: { configuredPath?: string; workspaceRoot?: string } = {}): Promise<string | undefined> {
  const candidates = [
    options.configuredPath,
    ...commonInstallPaths,
    ...(options.workspaceRoot ? await portableCandidates(options.workspaceRoot) : []),
    ...(await pathCandidates()),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (await validateXshellExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function validateXshellExecutable(file: string): Promise<boolean> {
  if (path.basename(file).toLowerCase() !== "xshell.exe") return false;
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function isLocalPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function recommendAvailableLocalPort(startPort: number, host = "127.0.0.1"): Promise<number> {
  const start = Math.max(1024, Math.min(65535, Math.floor(startPort)));
  for (let port = start; port <= 65535; port += 1) {
    if (await isLocalPortAvailable(port, host)) return port;
  }
  for (let port = 1024; port < start; port += 1) {
    if (await isLocalPortAvailable(port, host)) return port;
  }
  throw new Error("没有可用的本地端口。");
}

export function buildForwardCommand(config: XshellTunnelSetupConfig): string {
  return buildXshellForwardCommand(config);
}

export function buildXshellPreview(config: XshellTunnelSetupConfig): string {
  return buildXshellTunnelCommand(config).redactedShellCommand;
}

export function launchXshellTunnel(config: XshellTunnelSetupConfig): void {
  void launchXshellTunnelProcess(config);
}

export function generateBatScript(config: XshellTunnelSetupConfig): string {
  return generateXshellBatScript(config);
}

export function generatePs1Script(config: XshellTunnelSetupConfig): string {
  return generateXshellPs1Script(config);
}

async function portableCandidates(root: string): Promise<string[]> {
  const names = ["Xshell.exe", path.join("tools", "Xshell.exe"), path.join("bin", "Xshell.exe")];
  return names.map((name) => path.join(root, name));
}

async function pathCandidates(): Promise<string[]> {
  const envPath = process.env.PATH || "";
  return envPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "Xshell.exe"));
}

export { buildXshellArgs };
