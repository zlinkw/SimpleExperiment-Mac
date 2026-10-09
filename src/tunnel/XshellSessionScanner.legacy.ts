import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface XshellTunnelForward {
  index: number;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface XshellSessionInfo {
  name: string;
  filePath: string;
  relativePath?: string;
  host?: string;
  userName?: string;
  port?: number;
  remoteCommand?: string;
  forwards: XshellTunnelForward[];
}

export interface XshellSessionScanResult {
  searchedDirs: string[];
  existingDirs: string[];
  sessions: XshellSessionInfo[];
  limited?: boolean;
  scannedDirectoryCount?: number;
  scannedFileCount?: number;
  skippedDirectoryCount?: number;
  warning?: string;
}

export interface XshellSessionScanOptions {
  maxDirectories?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  ignoredDirectoryNames?: string[];
}

export function defaultXshellSessionDirs(home = os.homedir()): string[] {
  const roots = unique([
    home,
    process.env.USERPROFILE || "",
    process.env.HOME || "",
    process.env.HOMEDRIVE && process.env.HOMEPATH ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : "",
  ]);
  const documentRoots = unique([
    ...roots.map((root) => path.join(root, "Documents")),
    ...roots.map((root) => path.join(root, "OneDrive", "Documents")),
    process.env.OneDrive ? path.join(process.env.OneDrive, "Documents") : "",
    process.env.OneDriveCommercial ? path.join(process.env.OneDriveCommercial, "Documents") : "",
    process.env.OneDriveConsumer ? path.join(process.env.OneDriveConsumer, "Documents") : "",
  ]);
  return unique(documentRoots.flatMap((documents) => [
    path.join(documents, "NetSarang Computer", "8", "Xshell", "Sessions"),
    path.join(documents, "NetSarang Computer", "7", "Xshell", "Sessions"),
  ]));
}

const defaultScanOptions: Required<XshellSessionScanOptions> = {
  maxDirectories: 800,
  maxFiles: 2000,
  maxDepth: 12,
  maxFileBytes: 512 * 1024,
  ignoredDirectoryNames: [
    ".git",
    ".hg",
    ".svn",
    ".vscode",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "env",
    ".conda",
    "datasets",
    "data",
    "weights",
    "checkpoints",
    "outputs",
    "work_dirs",
    "runs",
    "logs",
    "dist",
    "build",
  ],
};

export async function scanXshellSessions(dirs = defaultXshellSessionDirs(), options: XshellSessionScanOptions = {}): Promise<XshellSessionScanResult> {
  const limits = normalizeScanOptions(options);
  const existingDirs: string[] = [];
  const sessions: XshellSessionInfo[] = [];
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const budget: XshellScanBudget = {
    directoryCount: 0,
    fileCount: 0,
    skippedDirectoryCount: 0,
    limited: false,
  };
  for (const dir of unique(dirs)) {
    if (budget.limited) break;
    const dirKey = await pathKey(dir).catch(() => normalizePathKey(dir));
    if (seenDirs.has(dirKey)) continue;
    if (!(await isDirectory(dir))) continue;
    seenDirs.add(dirKey);
    existingDirs.push(dir);
    for (const filePath of await walkXshFiles(dir, limits, budget)) {
      const fileKey = await pathKey(filePath).catch(() => normalizePathKey(filePath));
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      const info = await readXshellSessionFile(filePath, dir).catch(() => undefined);
      if (info) sessions.push(info);
    }
  }
  return {
    searchedDirs: unique(dirs),
    existingDirs,
    sessions: sessions.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    limited: budget.limited || undefined,
    scannedDirectoryCount: budget.directoryCount,
    scannedFileCount: budget.fileCount,
    skippedDirectoryCount: budget.skippedDirectoryCount || undefined,
    warning: budget.limited ? "Xshell 会话扫描已达到安全预算，请缩小扫描目录或手动选择 .xsh 会话。" : undefined,
  };
}

export async function readXshellSessionFile(filePath: string, rootDir?: string): Promise<XshellSessionInfo> {
  const buffer = await fs.readFile(filePath);
  return parseXshellSessionContent(buffer, filePath, rootDir);
}

export function parseXshellSessionContent(input: Buffer | string, filePath: string, rootDir?: string): XshellSessionInfo {
  const text = typeof input === "string" ? input : decodeXshellText(input);
  const values = parseIniValues(text);
  const forwards = parseForwards(values);
  const name = path.basename(filePath, path.extname(filePath));
  return {
    name,
    filePath,
    relativePath: rootDir ? path.relative(rootDir, filePath) : undefined,
    host: stringValue(values.Host),
    userName: stringValue(values.UserName),
    port: numberValue(values.Port),
    remoteCommand: stringValue(values.RemoteCommand),
    forwards,
  };
}

export function preferredSimpleForward(session: XshellSessionInfo | undefined): XshellTunnelForward | undefined {
  if (!session) return undefined;
  return session.forwards.find((item) => item.remotePort === 18765)
    || session.forwards.find((item) => item.localPort >= 18765 && item.localPort <= 18999)
    || session.forwards[0];
}

function decodeXshellText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  if (buffer.includes(0)) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function parseIniValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith(";")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

function parseForwards(values: Record<string, string>): XshellTunnelForward[] {
  const groups = new Map<number, Record<string, string>>();
  for (const [key, value] of Object.entries(values)) {
    const match = /^FwdReq_(\d+)_(.+)$/.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const group = groups.get(index) || {};
    group[match[2]] = value;
    groups.set(index, group);
  }
  const forwards: XshellTunnelForward[] = [];
  for (const [index, group] of groups) {
    const localPort = numberValue(group.Port);
    const remotePort = numberValue(group.HostPort);
    if (!localPort || !remotePort) continue;
    forwards.push({
      index,
      localHost: group.Source || "127.0.0.1",
      localPort,
      remoteHost: group.Host || "127.0.0.1",
      remotePort,
    });
  }
  return forwards.sort((a, b) => a.index - b.index);
}

interface NormalizedScanOptions {
  maxDirectories: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  ignoredDirectoryNames: Set<string>;
}

interface XshellScanBudget {
  directoryCount: number;
  fileCount: number;
  skippedDirectoryCount: number;
  limited: boolean;
}

async function walkXshFiles(dir: string, options: NormalizedScanOptions, budget: XshellScanBudget, depth = 0): Promise<string[]> {
  const out: string[] = [];
  if (budget.limited) return out;
  if (depth > options.maxDepth) {
    budget.skippedDirectoryCount += 1;
    budget.limited = true;
    return out;
  }
  budget.directoryCount += 1;
  if (budget.directoryCount > options.maxDirectories) {
    budget.limited = true;
    return out;
  }
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (budget.limited) break;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (options.ignoredDirectoryNames.has(item.name.toLowerCase())) {
        budget.skippedDirectoryCount += 1;
        continue;
      }
      out.push(...await walkXshFiles(full, options, budget, depth + 1));
    } else if (item.isFile() && item.name.toLowerCase().endsWith(".xsh")) {
      budget.fileCount += 1;
      if (budget.fileCount > options.maxFiles) {
        budget.limited = true;
        break;
      }
      const stats = await fs.stat(full).catch(() => undefined);
      if (stats && stats.size > options.maxFileBytes) continue;
      out.push(full);
    }
  }
  return out;
}

function normalizeScanOptions(options: XshellSessionScanOptions): NormalizedScanOptions {
  const ignored = options.ignoredDirectoryNames?.length ? options.ignoredDirectoryNames : defaultScanOptions.ignoredDirectoryNames;
  return {
    maxDirectories: numberValue(options.maxDirectories) || defaultScanOptions.maxDirectories,
    maxFiles: numberValue(options.maxFiles) || defaultScanOptions.maxFiles,
    maxDepth: numberValue(options.maxDepth) || defaultScanOptions.maxDepth,
    maxFileBytes: numberValue(options.maxFileBytes) || defaultScanOptions.maxFileBytes,
    ignoredDirectoryNames: new Set(ignored.map((item) => item.toLowerCase())),
  };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function pathKey(filePath: string): Promise<string> {
  return normalizePathKey(await fs.realpath(filePath));
}

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}