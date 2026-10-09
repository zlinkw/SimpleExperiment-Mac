import { PreviewPlan, PreviewManifest, COMPONENT_IDS } from "./PreviewRelease";
import { ReleaseComponent } from "./Vsix";
const compare = require("../vendor/semver/functions/compare");

export const TRANSACTION_KEY = "simpleExperimentMac.preview.transaction.v1";
export interface UpdateJournal {
  manifest: PreviewManifest;
  completed: string[];
  status: "preparing" | "installing" | "reload_required" | "failed";
  error?: string;
}
export interface UpdateIO {
  readJournal(): UpdateJournal | undefined;
  saveJournal(value: UpdateJournal): Promise<void>;
  currentVersion(id: string): string;
  beginGate(): Promise<void>;
  waitForTransfers(): Promise<void>;
  endGate(): Promise<void>;
  downloadAndVerify(component: ReleaseComponent): Promise<string>;
  verifyPrepared(file: string, component: ReleaseComponent): Promise<void>;
  install(file: string): Promise<void>;
  reload(): Promise<void>;
}
export class UpdateTransaction {
  private active?: Promise<UpdateJournal>;
  constructor(private io: UpdateIO) {}
  install(plan: PreviewPlan): Promise<UpdateJournal> {
    if (this.active) return this.active;
    this.active = this.run(plan).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(plan: PreviewPlan): Promise<UpdateJournal> {
    const previous = this.io.readJournal();
    const journal: UpdateJournal = { manifest: plan.manifest, completed: previous?.manifest.releaseTag === plan.manifest.releaseTag ? [...previous.completed] : [], status: "preparing" };
    const components = COMPONENT_IDS.map(id => plan.manifest.components.find(item => item.extensionId === id)!);
    if (components.some(item => !item)) throw new Error("更新事务缺少配套组件");
    for (const item of components) {
      if (compare(this.io.currentVersion(item.extensionId) || "0.0.0", item.version) >= 0 && !journal.completed.includes(item.extensionId)) journal.completed.push(item.extensionId);
    }
    const pending = components.filter(item => !journal.completed.includes(item.extensionId));
    if (!pending.length) return { ...journal, status: "reload_required" };
    let gate = false, installedThisAttempt = false;
    try {
      // beginGate must stop new local work before waiting for existing transfers.
      await this.io.beginGate(); gate = true;
      await this.io.saveJournal(journal);
      await this.io.waitForTransfers();
      const prepared = new Map<string, string>();
      for (const component of pending) prepared.set(component.extensionId, await this.io.downloadAndVerify(component));
      // Every pending package is downloaded and verified before the first install.
      journal.status = "installing"; await this.io.saveJournal(journal);
      for (const component of pending) {
        // A concurrently installed equal/newer version must never be overwritten.
        if (compare(this.io.currentVersion(component.extensionId) || "0.0.0", component.version) < 0) {
          const file = prepared.get(component.extensionId)!;
          await this.io.verifyPrepared(file, component);
          await this.io.install(file);
          installedThisAttempt = true;
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
      if (gate && !installedThisAttempt) await this.io.endGate();
    }
  }
}
