import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const satisfies = require("../vendor/semver/functions/satisfies");
const valid = require("../vendor/semver/functions/valid");
const validRange = require("../vendor/semver/ranges/valid");

export interface ReleaseComponent {
  extensionId: string;
  version: string;
  sourceCommit: string;
  targetPlatform: "darwin-arm64";
  vscodeEngine: string;
  downloadUrl: string;
  size: number;
  sha256: string;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function readVsix(bytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(bytes);
  if (zip.length < 22 || zip.length > 128 * 1024 * 1024) throw new Error("VSIX 大小无效");
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error("VSIX ZIP 尾部无效");
  const count = zip.readUInt16LE(end + 10), directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (!count || count > 10000 || zip.readUInt16LE(end + 8) !== count || directoryOffset + directorySize !== end) throw new Error("VSIX ZIP 目录无效");
  const output = new Map<string, Buffer>();
  let offset = directoryOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("VSIX ZIP 条目无效");
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || size > 32 * 1024 * 1024 || (total += size) > 256 * 1024 * 1024) throw new Error("VSIX 压缩条目无效");
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!name || name.includes("\\") || name.startsWith("/") || name.includes("\0") || name.split("/").includes("..") || output.has(name)) throw new Error("VSIX 路径或重复条目无效");
    const mode = zip.readUInt32LE(offset + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000 || local + 30 > directoryOffset || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("VSIX 本地条目无效");
    const localNameSize = zip.readUInt16LE(local + 26), start = local + 30 + localNameSize + zip.readUInt16LE(local + 28);
    if (zip.readUInt16LE(local + 8) !== method || zip.readUInt16LE(local + 6) !== flags || start + compressed > directoryOffset || zip.subarray(local + 30, local + 30 + localNameSize).toString("utf8") !== name) throw new Error("VSIX 本地目录不一致");
    const data = zip.subarray(start, start + compressed);
    const body = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
    if (body.length !== size || crc32(body) !== crc) throw new Error("VSIX CRC 或长度不符");
    output.set(name, body);
    offset = next;
  }
  if (offset !== end) throw new Error("VSIX 目录长度不符");
  return output;
}

export function inspectVsix(bytes: Uint8Array) {
  const files = readVsix(bytes);
  const pkg = JSON.parse(files.get("extension/package.json")?.toString("utf8") || "null");
  const xml = files.get("extension.vsixmanifest")?.toString("utf8") || "";
  const identities = [...xml.matchAll(/<Identity\b([^>]*)\/?\s*>/g)];
  if (!pkg || identities.length !== 1) throw new Error("VSIX 缺少唯一包身份");
  const attr = (key: string) => new RegExp(`\\b${key}="([^"]+)"`).exec(identities[0][1])?.[1];
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  if (attr("Publisher") !== pkg.publisher || attr("Id") !== pkg.name || attr("Version") !== pkg.version || !valid(pkg.version) || !validRange(pkg.engines?.vscode)) throw new Error("VSIX 真实身份、版本或 VS Code 要求不一致");
  return { extensionId, version: pkg.version as string, targetPlatform: attr("TargetPlatform"), vscodeEngine: pkg.engines.vscode as string, files };
}

export function verifyVsix(bytes: Uint8Array, component: ReleaseComponent, vscodeVersion?: string) {
  if (bytes.byteLength !== component.size || createHash("sha256").update(bytes).digest("hex") !== component.sha256) throw new Error("VSIX 大小或 SHA-256 不符");
  const actual = inspectVsix(bytes);
  if (actual.extensionId !== component.extensionId || actual.version !== component.version || actual.targetPlatform !== "darwin-arm64" || component.targetPlatform !== actual.targetPlatform || actual.vscodeEngine !== component.vscodeEngine) throw new Error("VSIX 身份、版本、平台或兼容要求不符");
  if (vscodeVersion && !satisfies(vscodeVersion, actual.vscodeEngine)) throw new Error("VS Code 版本不兼容");
  return actual;
}
