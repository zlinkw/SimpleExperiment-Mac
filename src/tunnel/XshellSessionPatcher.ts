import * as fs from "fs/promises";

export interface XshellSessionLoginCommandUpdate {
  filePath: string;
  command: string;
  backupPath?: string;
  changed: boolean;
  skippedReason?: string;
}

export async function updateXshellSessionLoginCommand(
  filePath: string,
  command: string,
  options: { backup?: boolean; skipIfRemoteCommandIncludes?: string[]; managedAgentLogin?: boolean; preserveUnmanaged?: boolean } = {},
): Promise<XshellSessionLoginCommandUpdate> {
  const original = await fs.readFile(filePath);
  const encoding = detectEncoding(original);
  const text = decodeText(original, encoding);
  const existingCommand = getLoginCommand(text);
  const managed = decodeManagedLogin(existingCommand);
  if (options.preserveUnmanaged && !isSimpleManagedLoginCommand(existingCommand))
    return { filePath, command, changed: false, skippedReason: "preserved_login" };
  if (!managed && existingCommand && options.skipIfRemoteCommandIncludes?.some((marker) => marker && existingCommand === marker)) {
    return { filePath, command, changed: false, skippedReason: "existing_simple_command" };
  }
  const existing = String(existingCommand || "").trim();
  if (existing) {
    const targetSession = simpleAgentSessionName(command);
    const existingSession = simpleAgentSessionName(existing);
    if (!managed && !isSimpleManagedLoginCommand(existing) && options.managedAgentLogin !== true) {
      return { filePath, command, changed: false, skippedReason: "non_simple_remote_command" };
    }
    if (existingSession && targetSession && existingSession !== targetSession) {
      return { filePath, command, changed: false, skippedReason: "different_simple_agent_session" };
    }
  }
  const login = managed ? managed.login : existing && !isSimpleManagedLoginCommand(existing) ? existingCommand! : "exec bash -i";
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, login }), "utf8").toString("base64");
  // The lifecycle controller returns an API receipt, not interactive terminal output.
  // Keep only this managed startup segment quiet; original login output stays intact.
  // Plugin preparation/health requests still receive the complete structured receipt.
  const nextCommand = `SIMPLE_EXPERIMENT_LOGIN_V1=${payload}; (${command}) >/dev/null 2>&1; ${login}`;
  const nextText = setLoginCommand(text, nextCommand);
  if (nextText === text) return { filePath, command, changed: false };
  let backupPath: string | undefined;
  if (options.backup !== false) {
    backupPath = `${filePath}.simple-backup`;
    try { await fs.copyFile(filePath, backupPath, (await import("fs")).constants.COPYFILE_EXCL); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  await fs.writeFile(filePath, encodeText(nextText, encoding));
  return { filePath, command, backupPath, changed: true };
}

export function decodeManagedLogin(command?: string): { login: string } | undefined {
  if (!command?.startsWith("SIMPLE_EXPERIMENT_LOGIN_V1=")) return undefined;
  const match = command.match(/^SIMPLE_EXPERIMENT_LOGIN_V1=([A-Za-z0-9+/=]+); /);
  if (!match) throw new Error("MANAGED_AGENT_LOGIN_INVALID");
  const value = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  if (value.schemaVersion !== 1 || typeof value.login !== "string" || /[\r\n\0]/.test(value.login)) throw new Error("MANAGED_AGENT_LOGIN_INVALID");
  if (!command.endsWith(`; ${value.login}`)) throw new Error("MANAGED_AGENT_LOGIN_CHANGED");
  return value;
}

export function setLoginCommand(text: string, command: string): string {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (/^RemoteCommand=/i.test(line.trim())) {
      replaced = true;
      return `RemoteCommand=${command}`;
    }
    return line;
  });
  if (!replaced) next.push(`RemoteCommand=${command}`);
  return next.join("\r\n");
}

export function getLoginCommand(text: string): string | undefined {
  const normalized = text.replace(/^\uFEFF/, "");
  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^RemoteCommand=/i.test(trimmed)) continue;
    return trimmed.slice(trimmed.indexOf("=") + 1);
  }
  return undefined;
}

export function isSimpleManagedLoginCommand(command: string | undefined): boolean {
  const text = String(command || "");
  if (!text.trim()) return false;
  if (decodeManagedLogin(text)) return true;
  if (/SIMPLE_EXPERIMENT_AGENT_TMUX_V\d+=1/.test(text))
    return Boolean(simpleAgentSessionName(text) && /\bcluster_agent\.py\b/.test(text) && (/lifecycle --action ensure/.test(text) || /\bWORK_DIR=/.test(text)));
  if (/\bcluster_agent\.py\b/.test(text) && /\bSESSION=/.test(text)) return true;
  return Boolean(simpleAgentSessionName(text) && /\btmux\b/.test(text));
}

function simpleAgentSessionName(command: string | undefined): string {
  const text = String(command || "");
  const patterns = [
    /\bSESSION=(['"])([a-z0-9][a-z0-9._-]*-agent)\1/,
    /\bSESSION=([a-z0-9][a-z0-9._-]*-agent)\b/,
    /\btmux\s+(?:new-session|attach(?:-session)?|has-session|kill-session)[^;\r\n]*\s(?:-s|-t)\s+(['"]?)([a-z0-9][a-z0-9._-]*-agent)\1/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const session = match?.[2] || "";
    if (session) return session;
  }
  return "";
}

type TextEncoding = "utf16le" | "utf8";

function detectEncoding(buffer: Buffer): TextEncoding {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return "utf16le";
  if (buffer.includes(0)) return "utf16le";
  return "utf8";
}

function decodeText(buffer: Buffer, encoding: TextEncoding): string {
  return buffer.toString(encoding).replace(/^\uFEFF/, "");
}

function encodeText(text: string, encoding: TextEncoding): Buffer | string {
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  return text;
}
