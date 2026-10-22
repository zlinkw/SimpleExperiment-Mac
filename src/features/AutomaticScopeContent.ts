import type { MetadataFile, MetadataInventory } from "./SyncScopeMetadata";
import type { ScopeInventories } from "./SyncScopeStatus";

export type ContentFact = MetadataFile & { sha256: string };
export type ContentEndpoint = { id: string; binding: string; batchSize?: number;
  hash: (paths: string[], signal: AbortSignal | undefined, accept: (name: string, fact?: ContentFact, error?: string) => void) => Promise<{ files: Record<string, ContentFact>; unverifiedFiles?: Record<string, string> }> };

function identity(file: MetadataFile): string | undefined {
  return Number.isFinite(file.changedAtMs) && typeof file.device === "string" && typeof file.inode === "string"
    ? JSON.stringify([file.size, Math.floor(file.modifiedAtMs), file.changedAtMs, file.device, file.inode, file.contentRevision]) : undefined;
}
function matches(expected: MetadataFile, actual: ContentFact): boolean {
  return /^[a-f0-9]{64}$/i.test(actual.sha256 || "") && actual.size === expected.size && Math.floor(actual.modifiedAtMs) === Math.floor(expected.modifiedAtMs)
    && (["changedAtMs", "device", "inode"] as const).every(key => expected[key] === undefined || expected[key] === actual[key]);
}
function batches(paths: string[], limit: number): string[][] {
  const output: string[][] = []; let batch: string[] = [], bytes = 2;
  for (const name of paths) { const size = Buffer.byteLength(JSON.stringify(name), "utf8") + 1;
    if (batch.length && (batch.length >= limit || bytes + size > 64 * 1024)) { output.push(batch); batch = []; bytes = 2; }
    batch.push(name); bytes += size;
  }
  if (batch.length) output.push(batch); return output;
}

/** Page-only acceleration. Every reuse requires this round's live index identity.
 * It neither authorizes a file operation nor supplies PLAN/artifact completion evidence. */
export class AutomaticScopeContent {
  private caches = new Map<string, Map<string, { identity: string; fact: ContentFact }>>();
  private revision = 0;
  async verify(endpoints: ContentEndpoint[], inventories: Record<string, MetadataInventory>, unavailable: Map<string, string>,
    signal: AbortSignal | undefined, publish: (value: ScopeInventories) => void, report: (stage: string) => void = () => {}) {
    const revision = ++this.revision;
    const current = () => { signal?.throwIfAborted(); if (revision !== this.revision) throw Error("SCOPE_CONTENT_SUPERSEDED"); };
    const files: Record<string, Record<string, ContentFact>> = {}, unverified: Record<string, Record<string, string>> = {};
    const snapshot = (): ScopeInventories => ({ local: files.local || {}, workers: Object.fromEntries(Object.entries(files).filter(([id]) => id !== "local")), unverified });
    let lastPublish = 0;
    const changed = (force = false) => { current(); if (force || Date.now() - lastPublish >= 500) { publish(snapshot()); lastPublish = Date.now(); } };
    const jobs = endpoints.map(endpoint => {
      files[endpoint.id] = {}; unverified[endpoint.id] = {};
      const inventory = inventories[endpoint.id], pending: string[] = [];
      const cache = this.caches.get(endpoint.binding) || new Map(); this.caches.set(endpoint.binding, cache);
      if (!inventory || unavailable.has(endpoint.id)) { cache.clear(); return { endpoint, pending, cache }; }
      for (const name of cache.keys()) if (!inventory.files[name]) cache.delete(name);
      for (const [name, file] of Object.entries(inventory.files)) {
        const unread = Object.entries(inventory.unverifiedFiles || {}).find(([root]) => root === "." || root === name || name.startsWith(root + "/"))?.[1];
        const key = identity(file), saved = cache.get(name);
        if (unread) { cache.delete(name); unverified[endpoint.id][name] = unread; }
        else if (key && saved?.identity === key) files[endpoint.id][name] = saved.fact;
        else { cache.delete(name); pending.push(name); unverified[endpoint.id][name] = "正在自动校验内容"; }
      }
      for (const [name, error] of Object.entries(inventory.unverifiedFiles || {})) unverified[endpoint.id][name] = error;
      return { endpoint, pending, cache };
    });
    changed(true);
    await Promise.all(jobs.map(async ({ endpoint, pending, cache }) => {
      let done = 0, lastReport = 0;
      // Local hashing reads/writes its persistent cache once; remote scopes stay SSH/stdin bounded.
      const groups = endpoint.id === "local" ? (pending.length ? [pending] : []) : batches(pending, endpoint.batchSize || 256);
      for (const paths of groups) {
        current(); const requested = new Set(paths), accepted = new Set<string>();
        const accept = (name: string, fact?: ContentFact, error?: string) => {
          current(); if (!requested.has(name) || accepted.has(name)) return; accepted.add(name);
          const expected = inventories[endpoint.id].files[name];
          if (!error && fact && matches(expected, fact)) {
            files[endpoint.id][name] = fact; delete unverified[endpoint.id][name];
            const key = identity(expected); if (key) cache.set(name, { identity: key, fact });
          } else { cache.delete(name); delete files[endpoint.id][name]; unverified[endpoint.id][name] = error || "文件在索引与内容校验之间发生变化，等待下一轮核实"; }
          done++; if (done === pending.length || Date.now() - lastReport >= 250) { report(`${endpoint.id}：自动内容校验 ${done}/${pending.length} · 索引已读取`); lastReport = Date.now(); } changed();
        };
        try {
          const result = await endpoint.hash(paths, signal, accept); current();
          for (const name of paths) accept(name, result.files?.[name], result.unverifiedFiles?.[name] || (!result.files?.[name] ? "本轮内容未核实，不能据此确认缺失" : undefined));
        } catch (error) {
          current(); for (const name of paths) accept(name, undefined, error instanceof Error ? error.message : String(error));
        }
      }
      if (!pending.length) report(`${endpoint.id}：内容校验复用本轮未变化文件 ${Object.keys(files[endpoint.id]).length} 个`);
    }));
    current(); changed(true);
    while (this.caches.size > 16) this.caches.delete(this.caches.keys().next().value!);
    return snapshot();
  }
}
