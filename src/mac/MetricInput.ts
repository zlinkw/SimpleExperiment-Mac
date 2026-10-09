import { createHash } from "node:crypto";
import { normalizePosixRelativePath } from "./PosixPath";

export const MAC_METRIC_MAX_BYTES = 4 * 1024 * 1024;
export type MacMetricInput = { remotePath: string; text: string; bytes: number; sha256: string; encoding?: "base64" };

/** Validate actual bytes again at the parser boundary; cached rows and hash labels are not input evidence. */
export function verifyMacMetricInput(value: unknown, remotePath: string, binary: boolean, expectedHash?: unknown, expectedBytes?: unknown): MacMetricInput {
  normalizePosixRelativePath(remotePath, "Mac 指标来源相对路径");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mac 指标输入无效。");
  const file = value as Record<string, unknown>;
  if (file.remotePath !== remotePath || typeof file.text !== "string"
    || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > MAC_METRIC_MAX_BYTES
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)
    || (binary ? file.encoding !== "base64" : file.encoding !== undefined)) throw new Error("Mac 指标来源、大小、hash 或编码无效。");
  if (expectedHash !== undefined && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash))
    || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || Number(expectedBytes) < 0 || Number(expectedBytes) > MAC_METRIC_MAX_BYTES))
    throw new Error("Mac 指标清单大小或 hash 无效。");
  if (binary ? file.text.length > 4 * Math.ceil(MAC_METRIC_MAX_BYTES / 3) : Buffer.byteLength(file.text, "utf8") > MAC_METRIC_MAX_BYTES)
    throw new Error("Mac 指标内容超过轻量接收上限。");
  const bytes = Buffer.from(file.text, binary ? "base64" : "utf8");
  if (binary ? bytes.toString("base64") !== file.text : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== file.text)
    throw new Error("Mac 指标内容编码无效。");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== file.bytes || sha256 !== file.sha256.toLowerCase()
    || expectedHash !== undefined && sha256 !== String(expectedHash).toLowerCase()
    || expectedBytes !== undefined && bytes.length !== expectedBytes) throw new Error("Mac 指标内容与清单大小或 SHA256 不符：" + remotePath);
  return { remotePath, text: file.text, bytes: bytes.length, sha256, ...(binary ? { encoding: "base64" as const } : {}) };
}

export function macMetricInputFromBytes(remotePath: string, bytes: Buffer, binary: boolean, expectedHash?: unknown, expectedBytes?: unknown): MacMetricInput {
  if (bytes.length > MAC_METRIC_MAX_BYTES) throw new Error("Mac 指标内容超过轻量接收上限。");
  return verifyMacMetricInput({ remotePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    text: binary ? bytes.toString("base64") : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ...(binary ? { encoding: "base64" } : {}) }, remotePath, binary, expectedHash, expectedBytes);
}
