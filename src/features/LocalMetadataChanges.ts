import { watch, type FSWatcher } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { scopeInventoryPathAllowed } from "./SyncScopeStatus";

const drives = new Map<string, Promise<boolean>>();
async function fixedWindowsDrive(root: string, volume: string): Promise<boolean> {
  if (process.platform !== "win32" || !/^[a-z]:\\/i.test(root)) return false;
  const drive = path.parse(root).root.toUpperCase();
  const key = drive + ":" + volume;
  let result = drives.get(key);
  if (!result) {
    // A mapped network drive cannot provide the same notification guarantees as a local volume.
    result = promisify(execFile)("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$d=[IO.DriveInfo]::new($env:SIMPLEEX_INDEX_DRIVE); if($d.DriveType -eq 'Fixed' -and $d.DriveFormat -in @('NTFS','ReFS')){'LOCAL'}"],
    { windowsHide: true, timeout: 3000, encoding: "utf8", env: { ...process.env, SIMPLEEX_INDEX_DRIVE: drive } })
      .then(value => value.stdout.trim() === "LOCAL", () => false);
    drives.set(key, result);
    while (drives.size > 64) drives.delete(drives.keys().next().value!);
  }
  return result;
}

/** A process-local change cursor, never restored from disk. Reloads/gaps reconcile all saved identities.
 * Native notifications accelerate browsing only; PLAN, hashes and destructive previews remain live reads.
 * See node:fs fs.watch caveats: errors, unknown names, remote volumes and root replacement fail closed. */
export class LocalMetadataChanges {
  private watcher?: FSWatcher;
  private binding = "";
  private attempted = false;
  private gap = true;
  private version = 0;
  private dirty = new Set<string>();
  private lastReconciled = -Infinity;

  invalidate() { this.gap = true; this.version++; }
  close() { this.invalidate(); this.attempted = false; const watcher = this.watcher; this.watcher = undefined; watcher?.close(); }

  async start(root: string, identity: string, volume: string) {
    if (identity !== this.binding) { this.close(); this.binding = identity; }
    if (this.attempted) return;
    this.attempted = true;
    if (!await fixedWindowsDrive(root, volume)) return;
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) { this.invalidate(); return; }
        const name = filename.toString().replaceAll("\\", "/");
        if (name.length > 4096 || /[:\x00-\x1f]/.test(name) || name.split("/").some(p => !p || p === "." || p === "..")) {
          this.invalidate(); return;
        }
        if (!scopeInventoryPathAllowed(name, true)) return;
        this.version++;
        if (this.dirty.size >= 10000) { this.dirty.clear(); this.invalidate(); }
        else this.dirty.add(name);
      });
      this.watcher = watcher;
      watcher.on("error", () => this.close());
      watcher.on("close", () => { if (this.watcher === watcher) this.close(); });
    } catch { this.attempted = false; this.invalidate(); }
  }

  async snapshot() {
    // Let ReadDirectoryChangesW completions reach JS before and after each active query.
    await new Promise(resolve => setTimeout(resolve, 5));
    return { version: this.version, dirty: new Set(this.dirty), native: !!this.watcher && !this.gap
      // Keep the defensive full sweep independent of the UI's 30-second browse round.
      // Otherwise every real folder expansion after an idle period degenerates to a full scan.
      && performance.now() - this.lastReconciled < 5 * 60 * 1000 };
  }

  async complete(snapshot: { version: number }, reconciled: boolean) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (snapshot.version !== this.version) throw Error("LOCAL_INDEX_DIRECTORY_CHANGED: notifications during validation");
    this.dirty.clear();
    if (reconciled && this.watcher) { this.gap = false; this.lastReconciled = performance.now(); }
  }
}
