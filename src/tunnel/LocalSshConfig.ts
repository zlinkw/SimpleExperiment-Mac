import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface LocalSshServerInfo {
  name: string;
  hostName: string;
  user: string;
  port: number;
  identityFile?: string;
  sourcePath: string;
}

type HostBlock = {
  names: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

export async function readLocalSshServers(configPath = defaultSshConfigPath()): Promise<LocalSshServerInfo[]> {
  try {
    const text = await fs.readFile(configPath, "utf8");
    return parseLocalSshConfig(text, configPath);
  } catch {
    return [];
  }
}

export function parseLocalSshConfig(text: string, sourcePath = defaultSshConfigPath()): LocalSshServerInfo[] {
  const blocks: HostBlock[] = [];
  let current: HostBlock | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = unquote(match[2].trim());
    if (key === "host") {
      current = { names: value.split(/\s+/).filter((item) => item && !hasPattern(item)) };
      if (current.names.length) blocks.push(current);
      else current = undefined;
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.hostName = value;
    else if (key === "user") current.user = value;
    else if (key === "port") current.port = normalizeSshPort(value);
    else if (key === "identityfile" && !current.identityFile) current.identityFile = expandHome(value);
  }
  const seen = new Set<string>();
  const out: LocalSshServerInfo[] = [];
  for (const block of blocks) {
    for (const name of block.names) {
      const hostName = block.hostName || name;
      const key = `${name}\n${hostName}\n${block.user || ""}\n${block.port || 22}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        hostName,
        user: block.user || "",
        port: block.port || 22,
        identityFile: block.identityFile,
        sourcePath,
      });
    }
  }
  return out;
}

function stripComment(line: string): string {
  let quoted = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === "'" || ch === "\"") && line[i - 1] !== "\\") {
      if (!quoted) {
        quoted = true;
        quote = ch;
      } else if (quote === ch) {
        quoted = false;
        quote = "";
      }
    }
    if (ch === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasPattern(value: string): boolean {
  return /[*?!]/.test(value);
}

function normalizeSshPort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}