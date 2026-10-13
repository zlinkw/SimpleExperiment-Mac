import { PreviewPlan, PreviewManifest, COMPONENT_IDS } from "./PreviewRelease";
import { ReleaseComponent } from "./Vsix";
import { createHash } from "node:crypto";
const compare = require("../vendor/semver/functions/compare");

export const TRANSACTION_KEY = "simpleExperimentMac.preview.transaction.v1";
export interface UpdateJournal {
  manifest: PreviewManifest;
  completed: string[];
  status: "preparing" | "installing" | "reload_required" | "failed";
  error?: string;
  fingerprint?: string;
  installationRequested?: boolean;
}
export function updateJournalNeedsRecovery(journal: UpdateJournal | undefined): boolean {
  if (journal && (!Array.isArray(journal.completed) || !journal.manifest)) return true;
  return Boolean(journal && (journal.installationRequested === true || ["installing", "reload_required"].includes(journal.status)
    || journal.installationRequested === undefined && journal.completed.length > 0 && journal.status !== "preparing"));
}
export interface UpdateIO {
  readJournal(): UpdateJournal | undefined;
  saveJournal(value: UpdateJournal): Promise<void>;
  currentVersion(id: string): string;
  beginGate(): Promise<void>;
  waitForTransfers(signal?: AbortSignal): Promise<void>;
  endGate(): Promise<void>;
  downloadAndVerify(component: ReleaseComponent): Promise<string>;
  verifyPrepared(file: string, component: ReleaseComponent): Promise<void>;
  install(file: string): Promise<void>;
  reload(): Promise<void>;
}
export class UpdateTransaction {
  private active?: Promise<UpdateJournal>;
  constructor(private io: UpdateIO) {}
  install(plan: PreviewPlan, signal?: AbortSignal): Promise<UpdateJournal> {
    if (this.active) return this.active;
    this.active = this.run(structuredClone(plan), signal).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(plan: PreviewPlan, signal?: AbortSignal): Promise<UpdateJournal> {
    const previous = this.io.readJournal();
    const fingerprint = (manifest: PreviewManifest) => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const frozen = fingerprint(plan.manifest), prior = previous ? fingerprint(previous.manifest) : undefined;
    if (previous?.fingerprint && previous.fingerprint !== prior) throw new Error("更新事务清单身份发生变化，不能继续安装。");
    const partialRetry = updateJournalNeedsRecovery(previous);
    if (partialRetry && prior !== frozen) throw new Error("上次配套更新尚未完成；请先补装原批次并重载，不能替换更新清单。");
    const journal: UpdateJournal = { manifest: plan.manifest, fingerprint: frozen,
      completed: prior === frozen ? [...previous!.completed] : [], status: "preparing",
      installationRequested: Boolean(prior === frozen && previous?.installationRequested) };
    const components = COMPONENT_IDS.map(id => plan.manifest.components.find(item => item.extensionId === id)!);
    if (components.some(item => !item) || plan.manifest.components.length !== 2
      || new Set(plan.manifest.components.map(item => item.extensionId)).size !== 2
      || journal.completed.some(id => !COMPONENT_IDS.includes(id as any))) throw new Error("更新事务缺少唯一配套组件或回执身份无效");
    for (const item of components) {
      if (compare(this.io.currentVersion(item.extensionId) || "0.0.0", item.version) >= 0 && !journal.completed.includes(item.extensionId)) journal.completed.push(item.extensionId);
    }
    const pending = components.filter(item => !journal.completed.includes(item.extensionId));
    if (!pending.length && !partialRetry) return { ...journal, status: "reload_required" };
    // A retry after partial installation still owns a mixed component set,
    // even if this attempt fails before installing another package.
    let gate = false;
    try {
      // beginGate must stop new local work before waiting for existing transfers.
      signal?.throwIfAborted(); gate = true; await this.io.beginGate();
      await this.io.saveJournal(journal);
      await this.io.waitForTransfers(signal); signal?.throwIfAborted();
      const prepared = new Map<string, string>();
      for (const component of pending) { signal?.throwIfAborted(); prepared.set(component.extensionId, await this.io.downloadAndVerify(component)); }
      // Every pending package is downloaded and verified before the first install.
      journal.status = "installing"; await this.io.saveJournal(journal);
      for (const component of pending) {
        signal?.throwIfAborted();
        // A concurrently installed equal/newer version must never be overwritten.
        if (compare(this.io.currentVersion(component.extensionId) || "0.0.0", component.version) < 0) {
          const file = prepared.get(component.extensionId)!;
          await this.io.verifyPrepared(file, component);
          signal?.throwIfAborted();
          if (compare(this.io.currentVersion(component.extensionId) || "0.0.0", component.version) < 0) {
            journal.installationRequested = true;
            await this.io.saveJournal(journal);
            await this.io.install(file);
          }
        }
        journal.completed.push(component.extensionId);
        await this.io.saveJournal({ ...journal, completed: [...journal.completed] });
      }
      journal.status = "reload_required"; await this.io.saveJournal(journal);
      await this.io.reload();
      return journal;
    } catch (error) {
      journal.status = "failed"; journal.error = String((error as Error)?.message || error);
      await this.io.saveJournal(journal);
      throw Object.assign(new Error(`更新失败：${journal.error}。已完成：${journal.completed.join("、") || "无"}；待完成：${components.filter(item => !journal.completed.includes(item.extensionId)).map(item => item.extensionId).join("、") || "无"}`), { journal });
    } finally {
      // Installed extensions require a reload even if their companion failed.
      // Keeping the gate prevents mixed code from starting new local work.
      if (gate && !journal.installationRequested && !partialRetry && journal.status !== "reload_required") await this.io.endGate();
    }
  }
}
