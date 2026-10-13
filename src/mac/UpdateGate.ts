import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
const semver = require("semver");
import { LegacyHostOperationLeaseManager, defaultHostOperationLeasePath } from "../core/HostOperationLease";

let held: any;
let locallyBlocked = false;
export function setLocalUpdateBlocked(value: boolean): void { locallyBlocked = value === true; }
export function updateGateHeld(): boolean { return Boolean(held); }
export const MINIMUM_SFTP_DRAIN_VERSION = "0.2.101";
export function assertCompatibleSftpForUpdate(version: string): void {
  if (!semver.valid(version) || semver.lt(version, MINIMUM_SFTP_DRAIN_VERSION))
    throw new Error("配套更新等待协议需要 SimpleSFTP Mac 0.2.101 或以上；请等待本地传输完成后先安装配套 SimpleSFTP VSIX 并重载，再检查更新。");
}
export function assertBusinessAllowed(): void {
  if (locallyBlocked) throw new Error("配套插件更新尚未完成，请补装原批次并重载；暂不接受新业务操作。");
  try {
    const record = JSON.parse(fs.readFileSync(defaultHostOperationLeasePath(), "utf8"));
    if (record.actionType === "mac-preview-update" && Date.parse(record.expiresAt) > Date.now()) throw new Error("配套插件正在更新，等待本地传输完成后重载窗口；暂不接受新业务操作。");
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
}
export async function beginUpdateGate(storagePath: string): Promise<void> {
  if (held) { await held.assertHeld(); locallyBlocked = true; return; }
  const manager = new LegacyHostOperationLeaseManager({ windowId: `${hostname()}:${process.pid}:mac-preview-update:${randomUUID()}` });
  held = await manager.acquire({ pluginId: "simple-local.simple-experiment-mac", workspaceUri: "untitled://mac-preview-update", hostProjectPath: storagePath, actionType: "mac-preview-update", actionLabel: "Mac 配套更新" });
  locallyBlocked = true;
}
export async function endUpdateGate(): Promise<void> { await held?.release(); held = undefined; locallyBlocked = false; }
export async function waitForLocalOperations(signal?: AbortSignal): Promise<void> {
  const directory = defaultHostOperationLeasePath() + ".resources-v2";
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    await held?.assertHeld();
    const names = await fs.promises.readdir(directory).catch((error: any) => error.code === "ENOENT" ? [] : Promise.reject(error));
    let active = false;
    for (const name of names.filter(item => /^[0-9a-f]{64}\.json$/.test(item))) {
      const file = path.join(directory, name), stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("本地操作租约身份无效，已阻止更新");
      const row = JSON.parse(await fs.promises.readFile(file, "utf8"));
      if (row.schemaVersion !== 2 || !Array.isArray(row.leases) || !Number.isInteger(row.processId) || row.processId <= 0) throw new Error("本地操作租约损坏，已阻止更新");
      if (!row.leases.length && !row.choosing && !row.ticket) continue;
      // A live owner's expired receipt is not an exit proof. Existing operations
      // renew independently of admission and remove their own receipt on exit.
      try { process.kill(Number(row.processId), 0); active = true; }
      catch (error: any) { if (error.code !== "ESRCH") active = true; }
    }
    if (!active) return;
    if (Date.now() - started >= 300000) throw new Error("本地操作尚未结束，停止更新等待，现有传输继续运行；请完成后重试。");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
