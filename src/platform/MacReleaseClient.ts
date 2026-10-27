import { createHash } from "node:crypto";
import { ReleaseClient, RetryStore } from "../updates/ReleaseClient";
import { PreviewReleaseClient, parseManifest } from "../mac/PreviewRelease";
import { ComponentUpdate, PluginUpdatePlan, planPairedUpdates, compareSemanticVersions } from "../features/ExtensionUpdates";

/** Distribution metadata adapter. Installation/state/retry policy is Windows UpdateTransaction. */
export function macComponents(manifest: any, installed: (id: string) => string): ComponentUpdate[] {
  return manifest.components.map((c: any) => ({ id: c.extensionId,
    repo: c.extensionId.endsWith("sftp-mac") ? "zlinkw/SimpleSFTP-Mac" : "zlinkw/SimpleExperiment-Mac",
    label: c.extensionId.endsWith("sftp-mac") ? "SimpleSFTP Mac" : "SimpleExperiment Mac",
    currentVersion: installed(c.extensionId), latestVersion: c.version, targetPlatform: c.targetPlatform,
    updateAvailable: compareSemanticVersions(c.version, installed(c.extensionId)) > 0,
    releaseUrl: "https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/" + manifest.releaseTag,
    vsix: { name: new URL(c.downloadUrl).pathname.split("/").at(-1)!, url: c.downloadUrl, size: c.size,
      digest: "sha256:" + c.sha256, targetPlatform: c.targetPlatform } }));
}
export class MacReleaseClient extends ReleaseClient {
  // 静态 preview 索引是唯一更新来源；限流退避经 Bootstrap 的 globalState store 持久化，
  // 与 Windows 共同实现同一“延后而非失败”语义。
  private readonly previewSource: PreviewReleaseClient;
  constructor(private readonly vscodeVersion: string, retryStore?: RetryStore) {
    super();
    this.previewSource = new PreviewReleaseClient(fetch, Date.now, retryStore);
  }
  override async check(installed: (id: string) => string, manual = false): Promise<PluginUpdatePlan> {
    const source = await this.previewSource.check(this.vscodeVersion, installed, manual);
    const components = macComponents(source.manifest, installed);
    return planPairedUpdates(components[1], components[0]);
  }
}

/** Preserve old Mac receipts without a second installation state machine. */
export function macUpdateContext(context: any, vscodeVersion: string): any {
  const key = "simpleExperimentMac.update.transaction.v1", legacy = "simpleExperimentMac.preview.transaction.v1";
  const receiptKey = "simpleExperimentMac.platform.legacyUpdateReceiptConsumed.v1", state = context.globalState;
  return new Proxy(context, { get(target, property) {
    if (property !== "globalState") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
    return new Proxy(state, { get(storage, name) {
      if (name === "get") return (wanted: string, fallback?: any) => {
        const value = storage.get(wanted);
        if (wanted !== key || value !== undefined || storage.get(receiptKey, false)) return value === undefined ? fallback : value;
        const old = storage.get(legacy); if (!old) return fallback;
        try {
          const raw = old.manifest;
          const manifest = parseManifest(raw, { tag_name: raw.releaseTag, assets: raw.components.map((c: any) => ({ name: new URL(c.downloadUrl).pathname.split("/").at(-1), browser_download_url: c.downloadUrl, size: c.size })) }, vscodeVersion);
          const components = macComponents(manifest, () => "0.0.0");
          return { schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(components)).digest("hex"), components,
            completed: Array.isArray(old.completed) ? old.completed : [], installationRequested: Boolean(old.installationRequested || old.completed?.length),
            status: old.status === "reload_required" ? "reload_required" : "failed" };
        } catch {
          // An uncertain receipt must remain visible/blocked, never silently forgotten.
          return { schemaVersion: 1, components: [], completed: [], installationRequested: true, status: "failed" };
        }
      };
      if (name === "update") return async (wanted: string, value: any) => {
        await storage.update(wanted, value);
        if (wanted === key) await storage.update(receiptKey, true); // Original receipt remains preserved.
      };
      const value = Reflect.get(storage, name); return typeof value === "function" ? value.bind(storage) : value;
    } });
  } });
}
