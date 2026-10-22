import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const bindings = new WeakMap<object, PlanSubmissionBatch>();
export const planSubmissionBatchFor = (message: object) => bindings.get(message);

/** One live batch. Only common preparation is memoized; PLAN/result observations stay fresh. */
export class PlanSubmissionBatch {
  private shared = new Map<string, Promise<any>>();
  private active = new Map<string, Promise<any>>();
  private lanes = new Map<string, Promise<any>>();
  private closed = false;
  private code?: string;
  private revisions: Map<string, string>;
  private workerAssignments = new Map<string, string>();
  constructor(private host: any, private context: any, plans: any[], private current: () => void,
    private report: (text: string) => void = () => {}) {
    this.revisions = new Map(plans.map(plan => [String(plan.planFile || plan.file).replaceAll("\\", "/"), String(plan.revision || "")]));
  }
  bind(message: object) { this.check(); bindings.set(message, this); }
  selectWorker(body: any, candidates: string[]): string {
    this.check();
    const file = String(body.planFile || body.options?.planFile || "");
    const assigned = this.workerAssignments.get(file);
    if (assigned && candidates.includes(assigned)) return assigned;
    const ordered = [...new Set(candidates)].sort((a, b) =>
      [...this.workerAssignments.values()].filter(id => id === a).length - [...this.workerAssignments.values()].filter(id => id === b).length);
    if (!ordered.length) throw Error("没有可校验本批 PLAN 的 Worker。");
    this.workerAssignments.set(file, ordered[0]);
    return ordered[0];
  }
  async start() { this.code = await this.verify(); }
  check() { this.current(); if (this.closed) throw Error("本批提交已结束，不能复用准备结果。"); }
  private memo<T>(map: Map<string, Promise<any>>, key: string, work: () => Promise<T>): Promise<T> {
    this.check();
    let value = map.get(key);
    if (!value) {
      value = Promise.resolve().then(() => { this.check(); return work(); }).then(result => { this.check(); return result; });
      map.set(key, value);
    }
    return value.then(result => { this.check(); return result; });
  }
  once<T>(key: string, work: () => Promise<T>): Promise<T> { return this.memo(this.shared, key, work); }
  private fresh<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = this.memo(this.active, key, work);
    const pending = this.active.get(key);
    void result.finally(() => { if (this.active.get(key) === pending) this.active.delete(key); }).catch(() => {});
    return result;
  }
  serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      this.check(); const result = await work(); this.check(); return result;
    });
    this.lanes.set(key, next); return next;
  }
  async verify(body?: any): Promise<string> {
    this.check();
    if (body) {
      const file = String(body.planFile || body.options?.planFile || "").replaceAll("\\", "/");
      const revision = this.revisions.get(file);
      if (!revision || body.planRevision !== revision) throw Error("PLAN 版本与本批快照不一致，未提交：" + file);
      const text = await fs.readFile(path.join(this.context.root, file), "utf8");
      if (createHash("sha256").update(text).digest("hex") !== revision) throw Error("PLAN 已修改，请重新提交本批：" + file);
    }
    const actual = await this.fresh("code-observation", async () => {
      const value = await this.host.localDistributedCodeFingerprint(this.context.root);
      if (typeof value !== "string" || !value) throw Error("代码指纹未完成，未复用本批检查。");
      return value;
    });
    if (this.code && actual !== this.code) throw Error("代码或同步范围已变化，请重新提交本批；未复用旧校验。");
    this.check(); return actual;
  }
  async prepareCode(body: any) {
    await this.once("code-sync", async () => {
      this.code = await this.verify();
      this.report("同版本代码正在统一同步到全部已启用 Worker…");
      await this.host.ensureCodeReadyForRun(this.context, [], this.report);
      if (this.host.lastCodeSyncState?.fingerprint !== this.code || !this.host.enabledWorkerConfigs().every((worker: any) =>
        this.host.lastCodeSyncState?.workerVersions?.[worker.id]?.fingerprint === this.code))
        throw Error("本批代码同步未在全部 Worker 完成，未开始批量校验。");
      await this.verify();
    });
    await this.verify(body); return this.code;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...new Set([...this.shared.values(), ...this.active.values(), ...this.lanes.values()])]);
    this.shared.clear(); this.active.clear(); this.lanes.clear(); this.workerAssignments.clear();
  }
}
