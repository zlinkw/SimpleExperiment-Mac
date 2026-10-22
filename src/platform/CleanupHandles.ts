/** Native read-only proof only. The caller owns path approval and deletion. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export function assertDarwinCleanupHandles(file: string, fullPath: string, expected: { dev: bigint; ino: bigint }, inventory?: Array<{ device: string; inode: string }>): void {
  const unavailable = (message: string): never => { throw Object.assign(new Error(message), { code: "HANDLE_CHECK_UNAVAILABLE" }); };
  if (process.platform !== "darwin" || !path.isAbsolute(file) || path.basename(file) !== "mac_cleanup_handles.py")
    unavailable("HANDLE_CHECK_UNAVAILABLE：缺少原生句柄证明适配器。");
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || fs.realpathSync(file) !== file)
      unavailable("HANDLE_CHECK_UNAVAILABLE：句柄证明适配器身份无效。");
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "package.json"), "utf8"));
    if (pkg.publisher !== "simple-local" || pkg.name !== "simple-sftp-mac" || !pkg.files?.includes("mac_cleanup_handles.py"))
      unavailable("HANDLE_CHECK_UNAVAILABLE：需要包含原生句柄适配器的配套 SimpleSFTP Mac。");
  } catch (error: any) {
    unavailable(error.code === "HANDLE_CHECK_UNAVAILABLE" ? error.message : "HANDLE_CHECK_UNAVAILABLE：无法读取配套原生句柄适配器。");
  }
  let payload: any = { path: fullPath, device: String(expected.dev), inode: String(expected.ino) };
  if (inventory !== undefined) {
    if (!Array.isArray(inventory) || !inventory.length || inventory.length > 50000
      || inventory.some(row => !row || typeof row.device !== "string" || !/^\d+$/.test(row.device) || typeof row.inode !== "string" || !/^[1-9]\d*$/.test(row.inode)))
      unavailable("HANDLE_CHECK_UNAVAILABLE：冻结目录清单格式无效。");
    payload.inventory = inventory;
  }
  const child = spawnSync("python3", ["-B", "-X", "utf8", file], {
    input: JSON.stringify(payload),
    encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024,
  });
  if (child.error || child.status !== 0 || child.signal || child.stderr)
    unavailable("HANDLE_CHECK_UNAVAILABLE：原生句柄查询失败或超时，未执行删除。");
  let result: any;
  try { result = JSON.parse(child.stdout); }
  catch { unavailable("HANDLE_CHECK_UNAVAILABLE：句柄查询响应无效。"); }
  if (result?.ok !== true) {
    const code = result?.error?.code;
    if (["ACTIVE_HANDLE", "CONTENT_CHANGED"].includes(code)) throw Object.assign(new Error(`${code}：${String(result.error.message).slice(0, 300)}`), { code });
    unavailable("HANDLE_CHECK_UNAVAILABLE：无法取得完整的本机句柄证据。");
  }
  const proof = result.proof;
  if (proof?.schemaVersion !== 1 || proof.scope !== "visible_same_user_processes" || proof.uid !== process.getuid?.()
    || proof.path !== fullPath || proof.device !== String(expected.dev) || proof.inode !== String(expected.ino)
    || !Number.isSafeInteger(proof.processCount) || proof.processCount < 0)
    unavailable("HANDLE_CHECK_UNAVAILABLE：句柄证据与当前文件身份不符。");
}
