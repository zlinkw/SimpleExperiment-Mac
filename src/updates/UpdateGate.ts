import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { LegacyHostOperationLeaseManager, defaultHostOperationLeasePath } from "../core/HostOperationLease";

export const UPDATE_ACTION = "paired-plugin-update";
export class UpdateGate {
  private held: any;
  constructor(private leasePath = defaultHostOperationLeasePath(), private ownerAlive: (pid: number) => boolean = pid => {
    try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; }
  }) {}
  async begin(storagePath: string): Promise<void> {
    if (this.held) { await this.held.assertHeld(); return; }
    const manager = new LegacyHostOperationLeaseManager({ leasePath: this.leasePath, windowId: `${hostname()}:${process.pid}:${UPDATE_ACTION}:${randomUUID()}` });
    this.held = await manager.acquire({ pluginId: "simple-local.simple-experiment-mac", workspaceUri: "untitled://paired-plugin-update", hostProjectPath: storagePath,
      actionType: UPDATE_ACTION, actionLabel: "Mac 配套更新" });
  }
  async end(): Promise<void> { const lease = this.held; this.held = undefined; await lease?.release(); }
  async wait(signal?: AbortSignal): Promise<void> {
    const directory = this.leasePath + ".resources-v2", started = Date.now();
    for (;;) {
      signal?.throwIfAborted(); await this.held?.assertHeld();
      const names = await fs.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
      let active = false;
      for (const name of names.filter(n => /^[0-9a-f]{64}\.json$/.test(n))) {
        const file = path.join(directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("本地传输租约身份无效，已阻止安装。");
        const row = JSON.parse(await fs.readFile(file, "utf8"));
        if (row.schemaVersion !== 2 || !Array.isArray(row.leases) || !Number.isInteger(row.processId) || row.processId <= 0) throw new Error("本地传输租约损坏，已阻止安装。");
        // Expired heartbeat of a live/unknown owner is not an exit proof.
        if ((row.leases.length || row.choosing || row.ticket) && this.ownerAlive(row.processId)) active = true;
      }
      if (!active) return;
      if (Date.now() - started >= 300000) throw new Error("本地操作尚未结束；停止更新等待，现有传输继续运行。请稍后重试。");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
