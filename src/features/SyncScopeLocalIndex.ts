import { collectLocalScopeMetadata } from "./SyncScopeStatus";
import type { ScopeEntry, ScopeObservation } from "./SyncScopeTree";
import type { ProjectFileIndex } from "./ProjectFileIndex";
import { incrementalLocalMetadata } from "./IncrementalLocalMetadata";

/** One fresh local scan per page round, shared by directory browsing and summaries. */
export class SyncScopeLocalIndexReader {
  private request?: { round: string; promise: Promise<LocalIndex>; reports: Set<(stage: string) => void>; stage: string };
  private listing?: { files: unknown; directories: unknown; children: Map<string, ScopeEntry[]> };
  constructor(private readonly root: string, private readonly idleMs = 30_000, private readonly index?: ProjectFileIndex) {}

  read(round: string, signal?: AbortSignal, report?: (stage: string) => void): Promise<LocalIndex> {
    if (this.request?.round === round) {
      if (report) this.request.reports.add(report);
      if (this.request.stage) report?.(this.request.stage);
      return this.request.promise;
    }
    const request = { round, promise: undefined as unknown as Promise<LocalIndex>, reports: new Set(report ? [report] : []), stage: "" };
    this.request = request;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const error = new Error("本机索引连续无进展，状态未知；请刷新重试。最后进度：" + request.stage);
          controller.abort(error); reject(error);
        }, this.idleMs);
      };
      request.reports.add(reset); reset();
    });
    const load = () => incrementalLocalMetadata(this.root, this.index ? this.index.file + ".baseline" : undefined).read(controller.signal, stage => {
      if (controller.signal.aborted || this.request !== request) return;
      request.stage = stage;
      for (const listener of request.reports) listener(stage);
    });
    const scan = (this.index ? this.index.read({ method: "local.metadata", metadataOnly: true, recursive: true, backgroundPersistence: true, round, signal: controller.signal }, load) : load()).then(inventory => {
      controller.signal.throwIfAborted();
      if (this.listing?.files === inventory.files && this.listing.directories === inventory.directories)
        return { ...inventory, children: this.listing.children, observedAt: new Date().toISOString() };
      const children = new Map<string, ScopeEntry[]>();
      for (const [directory, rows] of [[true, inventory.directories], [false, inventory.files]] as const) for (const [relative, facts] of Object.entries(rows)) {
        if (relative === ".") continue;
        const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ".";
        const entries = children.get(parent) || [];
        entries.push({ name: relative.slice(relative.lastIndexOf("/") + 1), path: relative, directory, ...facts });
        children.set(parent, entries);
      }
      this.listing = { files: inventory.files, directories: inventory.directories, children };
      return { ...inventory, children, observedAt: new Date().toISOString() };
    });
    request.promise = Promise.race([scan, expired]).finally(() => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel); request.reports.clear();
    });
    return request.promise;
  }

  async list(relative: string, round: string, signal?: AbortSignal) {
    const index = await this.read(round, signal);
    signal?.throwIfAborted();
    const error = Object.entries(index.unverifiedFiles).find(([name]) => name === "." || name === relative || relative.startsWith(name + "/"))?.[1];
    const observation: ScopeObservation = { status: error ? "unknown" : index.directories[relative] ? "present" : "absent", directory: true, observedAt: index.observedAt, error };
    return Object.assign(index.children.get(relative) || [], { observation });
  }
}

type LocalIndex = Awaited<ReturnType<typeof collectLocalScopeMetadata>> & { children: Map<string, ScopeEntry[]>; observedAt: string };
