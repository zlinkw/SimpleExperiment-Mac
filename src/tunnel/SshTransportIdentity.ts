import { execFile } from "child_process";
import { LocalSshServerInfo } from "./LocalSshConfig";

export interface SshTransportTarget {
  id?: unknown;
  label?: unknown;
  displayName?: unknown;
  host?: unknown;
  networkHost?: unknown;
  displayHost?: unknown;
  transferHost?: unknown;
  resolvedHost?: unknown;
  sftpHost?: unknown;
  sshHost?: unknown;
  sshConfigHost?: unknown;
  sshConfigAlias?: unknown;
  savedSessionPath?: unknown;
  sessionName?: unknown;
  workerHost?: unknown;
  hubHost?: unknown;
}

export interface SshTransportSession {
  name?: unknown;
  host?: unknown;
}

export interface SshTransportIdentity {
  transportHost: string;
  sshConfigHost: string;
  sshConfigAlias: string;
  networkHost: string;
  source: "ssh_config_alias" | "saved_ssh_host" | "xshell_alias" | "ssh_config_match" | "network_host";
}

export interface SftpServerOptions {
  id: unknown;
  label: unknown;
  host: string;
  sftpHost: string;
  sshHost: string;
  transferHost: string;
  resolvedHost: string;
  user: unknown;
  username: unknown;
  port: unknown;
  sshPort: unknown;
  remotePath: unknown;
  sshConfigHost: string;
  sshConfigAlias: string;
  networkHost: string;
  savedSessionPath: unknown;
  source: "simple-experiment";
}

export function resolveSshTransportIdentity(
  target: SshTransportTarget,
  _options: {
    sshServers?: readonly LocalSshServerInfo[];
    session?: SshTransportSession;
  } = {},
): SshTransportIdentity {
  const configuredHost = firstConfiguredHost([
    target.workerHost,
    target.hubHost,
    target.host,
    target.transferHost,
    target.sftpHost,
    target.sshHost,
  ]);
  if (!configuredHost) {
    throw new Error(`${text(target.label) || text(target.displayName) || text(target.id) || "SSH 目标"} 缺少服务器地址；请在插件设置中填写 IP 地址或可直接解析的域名。`);
  }
  return {
    transportHost: configuredHost,
    sshConfigHost: "",
    sshConfigAlias: "",
    networkHost: configuredHost,
    source: "network_host",
  };
}

export function buildSftpServerOptions(
  target: SshTransportTarget & {
    user?: unknown;
    username?: unknown;
    port?: unknown;
    remotePath?: unknown;
  },
  identity: SshTransportIdentity,
): SftpServerOptions {
  return {
    id: target.id,
    label: target.label,
    host: identity.transportHost,
    sftpHost: identity.transportHost,
    sshHost: identity.transportHost,
    transferHost: identity.transportHost,
    resolvedHost: identity.transportHost,
    user: target.user,
    username: target.username ?? target.user,
    port: target.port,
    sshPort: target.port,
    remotePath: target.remotePath,
    sshConfigHost: identity.sshConfigHost,
    sshConfigAlias: identity.sshConfigAlias,
    networkHost: identity.networkHost,
    savedSessionPath: target.savedSessionPath,
    source: "simple-experiment",
  };
}

export interface OpenSshAliasInspection {
  ok: boolean;
  alias: string;
  hostname: string;
  user: string;
  port: string;
  message: string;
}

export async function inspectOpenSshAlias(
  alias: string,
  options: { timeoutMs?: number; command?: string } = {},
): Promise<OpenSshAliasInspection> {
  const name = String(alias || "").trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(options.command || "ssh", ["-G", "--", name], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
      child.on("error", reject);
    });
    const values = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(\S+)\s+(.+)$/.exec(line.trim());
      if (match) values.set(match[1].toLowerCase(), match[2].trim());
    }
    const hostname = values.get("hostname") || "";
    if (!hostname) throw new Error("ssh -G 未返回 hostname");
    return {
      ok: true,
      alias: name,
      hostname,
      user: values.get("user") || "",
      port: values.get("port") || "22",
      message: `SSH 别名可解析：alias=${name}，networkHost=${hostname}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      alias: name,
      hostname: "",
      user: "",
      port: "",
      message: `SSH 别名不可解析：alias=${name}。${message}`,
    };
  }
}

function firstConfiguredHost(values: readonly unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate && candidate !== "-" && candidate !== "—" && !/[\s\\/@]/.test(candidate)) return candidate;
  }
  return "";
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}
