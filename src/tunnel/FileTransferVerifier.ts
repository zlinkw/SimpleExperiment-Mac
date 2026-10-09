import * as crypto from "crypto";
import * as fs from "fs";
import { FileTransferVerifyResult } from "./FileTransferTypes";

export async function sha256File(file: string, options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file, { signal: options.signal });
    let bytes = 0;
    input.on("data", (chunk) => { hash.update(chunk); bytes += Buffer.byteLength(chunk); options.onBytes?.(bytes); });
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function verifyLocalFileSha256(
  transferId: string,
  localPath: string,
  expectedSha256?: string,
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<FileTransferVerifyResult> {
  if (!expectedSha256) return { transferId, ok: true, message: "No sha256 expected value provided." };
  const actualSha256 = await sha256File(localPath, options);
  const normalizedActualSha256 = actualSha256.toLowerCase();
  const normalizedExpectedSha256 = expectedSha256.toLowerCase();
  const ok = normalizedActualSha256 === normalizedExpectedSha256;
  return {
    transferId,
    ok,
    expectedSha256,
    actualSha256,
    message: ok ? "sha256 ok" : "sha256 mismatch",
  };
}
