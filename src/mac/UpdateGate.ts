import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { LegacyHostOperationLeaseManager, defaultHostOperationLeasePath } from "../core/HostOperationLease";

let held: any;
export function assertBusinessAllowed(): void {
  try {
    const record = JSON.parse(fs.readFileSync(defaultHostOperationLeasePath(), "utf8"));
    if (record.actionType === "mac-preview-update" && Date.parse(record.expiresAt) > Date.now()) throw new Error("配套插件正在更新，等待本地传输完成后重载窗口；暂不接受新业务操作。");
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
}
export async function beginUpdateGate(storagePath: string): Promise<void> {
  if (held) return;
  const manager = new LegacyHostOperationLeaseManager({ windowId: `mac-preview-update:${randomUUID()}` });
  held = await manager.acquire({ pluginId: "simple-local.simple-experiment-mac", workspaceUri: "untitled://mac-preview-update", hostProjectPath: storagePath, actionType: "mac-preview-update", actionLabel: "Mac 配套更新" });
}
export async function endUpdateGate(): Promise<void> { const lease = held; held = undefined; await lease?.release(); }
export async function waitForLocalOperations(): Promise<void> {
  const directory = defaultHostOperationLeasePath() + ".resources-v2";
  for (;;) {
    await held?.assertHeld();
    const names = await fs.promises.readdir(directory).catch((error: any) => error.code === "ENOENT" ? [] : Promise.reject(error));
    let active = false;
    for (const name of names.filter(item => /^[0-9a-f]{64}\.json$/.test(item))) {
      const file = path.join(directory, name), stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("本地操作租约身份无效，已阻止更新");
      const row = JSON.parse(await fs.promises.readFile(file, "utf8"));
      if (row.schemaVersion !== 2 || !Array.isArray(row.leases)) throw new Error("本地操作租约损坏，已阻止更新");
      if (!row.leases.length) continue;
      // A live owner's expired receipt is not an exit proof. Existing operations
      // renew independently of admission and remove their own receipt on exit.
      try { process.kill(Number(row.processId), 0); active = true; }
      catch (error: any) { if (error.code !== "ESRCH") active = true; }
    }
    if (!active) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
