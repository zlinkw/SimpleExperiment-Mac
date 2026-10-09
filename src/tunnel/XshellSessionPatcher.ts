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
  options: { backup?: boolean; skipIfRemoteCommandIncludes?: string[] } = {},
): Promise<XshellSessionLoginCommandUpdate> {
  const original = await fs.readFile(filePath);
  const encoding = detectEncoding(original);
  const text = decodeText(original, encoding);
  const existingCommand = getLoginCommand(text);
  if (existingCommand && options.skipIfRemoteCommandIncludes?.some((marker) => marker && existingCommand.includes(marker))) {
    return { filePath, command, changed: false, skippedReason: "existing_simple_command" };
  }
  const existing = String(existingCommand || "").trim();
  if (existing) {
    const targetSession = simpleAgentSessionName(command);
    const existingSession = simpleAgentSessionName(existing);
    if (!isSimpleManagedLoginCommand(existing)) {
      return { filePath, command, changed: false, skippedReason: "non_simple_remote_command" };
    }
    if (existingSession && targetSession && existingSession !== targetSession) {
      return { filePath, command, changed: false, skippedReason: "different_simple_agent_session" };
    }
  }
  const nextText = setLoginCommand(text, command);
  if (nextText === text) return { filePath, command, changed: false };
  let backupPath: string | undefined;
  if (options.backup !== false) {
    backupPath = `${filePath}.simple-backup`;
    await fs.copyFile(filePath, backupPath);
  }
  await fs.writeFile(filePath, encodeText(nextText, encoding));
  return { filePath, command, backupPath, changed: true };
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
  if (/SIMPLE_EXPERIMENT_AGENT_TMUX_V\d+=1/.test(text)) return true;
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
