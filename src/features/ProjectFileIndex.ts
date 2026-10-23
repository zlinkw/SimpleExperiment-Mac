import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { atomicWriteText } from "../state/StateStore";

export type FileIndexIdentity = { workspace: string; endpointId: string; projectRoot: string; connection: string; endpointBinding?: string };
export type FileIndexQuery = { method: string; relativePath?: string; paths?: string[]; recursive?: boolean; metadataOnly?: boolean;
  round?: string; binding?: Record<string, string | number>; signal?: AbortSignal; targetType?: "file" | "directory"; backgroundPersistence?: boolean };
export type IndexedFileFact = { path: string; type: "file" | "directory"; presence: "present" | "absent" | "unknown";
  size?: number; modifiedAtMs?: number; sha256?: string; error?: string; observedAt: string; observationId: string;
  device?: string; inode?: string; changedAtMs?: number };
type Observation = { observationId: string; generation: number; epoch: number; round: string; method: string;
  scope: { relativePath: string; paths: string[]; recursive: boolean }; basis: "metadata" | "sha256";
  binding: Record<string, string | number>; startedAt: string; observedAt: string; reusableUntil: string;
  sourceObservedAt?: string; sourceGeneration?: number;
  state: "reading" | "complete" | "partial" | "failed" | "invalidated"; error?: string; files: number; directories: number; unknown: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safe = (value: unknown) => typeof value === "string" && value.length <= 4096 && value !== "." && !/[\\:\x00-\x1f]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== "..");
const READS = new Set(["sync.projectInventory", "sync.projectTree", "sync.projectTreeState", "sync.projectFileStats", "files.cleanup.inspect"]);
const owners = new Map<string, ProjectFileIndex>();

/** Persisted facts are diagnostic history. Only a live read in the same explicit round can be reused. */
export class ProjectFileIndex {
  private epoch = 0;
  private generation = 0;
  private entries = new Map<string, IndexedFileFact>();
  private entryGenerations = new Map<string, number>();
  private entryScopes = new Map<string, { method: string; scope: { relativePath: string; paths: string[]; recursive: boolean } }>();
  private observations = new Map<string, Observation>();
  private reads = new Map<string, { at: number; epoch: number; promise: Promise<any> }>();
  private invalidatedAt = "";
  private invalidationReason = "";
  private invalidations: Array<{ epoch: number; paths: string[] }> = [];
  private writing: Promise<void> = Promise.resolve();
  private directoryDigests = new Map<string, string>();
  private directoryGroups = new Map<string, Record<string, any>>([[".", {}]]);
  private directoryChildren = new Map<string, Set<string>>();
  private directoryRefs = new Map<string, any>();
  private dirtyDirectories = new Set<string>(["."]);
  private directoryPublication: Record<string, any> = {};
  private listeners = new Set<(reason: string) => void>();
  readonly file: string;
  constructor(readonly identity: FileIndexIdentity, storageRoot: string, private readonly now = Date.now) {
    if (!identity.workspace || !identity.endpointId || !identity.projectRoot || !identity.connection) throw Error("FILE_INDEX_IDENTITY_REQUIRED");
    this.file = path.join(storageRoot, "file-index", hash(path.resolve(identity.workspace)), hash([identity.endpointId, identity.projectRoot]) + ".json");
    owners.set(this.file, this);
  }

  async read<T>(query: FileIndexQuery, load: () => Promise<T>): Promise<T> {
    query.signal?.throwIfAborted();
    if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED");
    // View metadata already comes from an actively verified baseline. Diagnostic JSON is not its proof.
    // Confirmation/operation readers keep their existing durable observation boundary.
    const background = query.backgroundPersistence === true && query.metadataOnly === true && ["local.metadata", "agent.metadata"].includes(query.method);
    const record = (observationOnly = false) => { const pending = this.persist(observationOnly); return background ? Promise.resolve() : pending; };
    const round = query.round?.slice(0, 4096) || randomUUID();
    const scope = { relativePath: query.relativePath || ".", paths: [...new Set(query.paths || [])].sort(), recursive: query.recursive === true };
    if (scope.relativePath !== "." && !safe(scope.relativePath) || scope.paths.some(name => name !== "." && !safe(name))) throw Error("FILE_INDEX_PATH_INVALID");
    const binding = Object.fromEntries(Object.entries(query.binding || {}).slice(0, 32).filter(([key, value]) => !/token|password|secret|credential|authorization|privatekey/i.test(key)
      && (typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 4096)));
    const basis = query.metadataOnly ? "metadata" : "sha256";
    const key = hash([round, scope, query.method, basis, binding, query.targetType]);
    const active = this.reads.get(key);
    // A cancelled consumer never shares another consumer's cancellation lifetime.
    if (!query.signal && query.round && active?.epoch === this.epoch && this.now() - active.at <= 2000) return active.promise;
    const epoch = this.epoch, generation = ++this.generation, observationId = randomUUID(), startedAt = new Date(this.now()).toISOString();
    const overlaps = (paths: string[]) => !paths.length || paths.some(changed => (scope.paths.length ? scope.paths : [scope.relativePath])
      .some(root => root === "." || root === changed || root.startsWith(changed + "/") || changed.startsWith(root + "/")));
    const promise = (async () => {
      try {
        for (const previous of this.observations.values()) if (previous.method === query.method && JSON.stringify(previous.scope) === JSON.stringify(scope)) previous.state = "invalidated";
        const previous = this.observations.get(key);
        if (previous) { this.observations.delete(key); this.observations.set(key + ":" + previous.observationId, previous); }
        this.observations.set(key, { observationId, generation, epoch, round, method: query.method, scope, basis, binding, startedAt,
          observedAt: startedAt, reusableUntil: startedAt, state: "reading", files: 0, directories: 0, unknown: 0 });
        this.trim(); await record(true);
        query.signal?.throwIfAborted();
        if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED");
        const value = await load();
        query.signal?.throwIfAborted();
        if (epoch !== this.epoch && (epoch < (this.invalidations[0]?.epoch || 1) - 1 || this.invalidations.some(row => row.epoch > epoch && overlaps(row.paths))))
          throw Error("FILE_INDEX_INVALIDATED_DURING_READ");
        const observedAt = new Date(this.now()).toISOString();
        const normalized = normalizeFileIndexResult(value, observedAt, observationId, query);
        for (const fact of normalized.facts) if (fact.presence === "absent" && this.entries.get(fact.path)?.type === "directory"
          && query.method !== "sync.projectFileStats" && query.targetType !== "file") fact.type = "directory";
        const observation: Observation = { observationId, generation, epoch: this.epoch, round, method: query.method, scope, basis, binding, startedAt, observedAt,
          reusableUntil: new Date(this.now() + 2000).toISOString(), state: normalized.state, error: normalized.error,
          sourceObservedAt: typeof (value as any)?.observedAt === "string" ? (value as any).observedAt : undefined,
          sourceGeneration: Number.isSafeInteger((value as any)?.indexGeneration) ? (value as any).indexGeneration : undefined,
          files: normalized.facts.filter(row => row.type === "file" && row.presence === "present").length,
          directories: normalized.facts.filter(row => row.type === "directory" && row.presence === "present").length,
          unknown: normalized.facts.filter(row => row.presence === "unknown").length };
        if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED");
        const currentPaths = new Set(normalized.facts.map(row => row.path));
        const absentDirectories = normalized.facts.filter(row => row.type === "directory" && row.presence === "absent"
          || row.type === "file" && row.presence === "present" && this.entries.get(row.path)?.type === "directory").map(row => row.path);
        const completeKinds = query.method === "sync.projectInventory" ? ["file"]
          : ["agent.metadata", "local.metadata", "sync.projectTree"].includes(query.method) ? ["file", "directory"] : [];
        const covered = (name: string) => {
          const roots = scope.paths.length ? scope.paths : [scope.relativePath];
          return roots.some(root => name === root || (root === "." || name.startsWith(root + "/"))
            && (scope.recursive || !name.slice(root === "." ? 0 : root.length + 1).includes("/")));
        };
        for (const [name, old] of this.entries) if (!currentPaths.has(name)) {
          const missingAncestor = absentDirectories.some(root => root === "." || name.startsWith(root + "/"));
          const previous = this.entryScopes.get(name);
          const enumerated = covered(name) && (completeKinds.includes(old.type) || previous?.method === query.method && JSON.stringify(previous.scope) === JSON.stringify(scope));
          if ((this.entryGenerations.get(name) || 0) > generation || !missingAncestor && !enumerated) continue;
          const absent = missingAncestor || normalized.state === "complete";
          this.putFact(name, { path: name, type: old.type, presence: absent ? "absent" : "unknown",
            error: absent ? undefined : normalized.error || "本轮清单不完整", observedAt, observationId });
          this.entryGenerations.set(name, generation);
          this.entryScopes.set(name, { method: query.method, scope });
        }
        if ((this.observations.get(key)?.generation || 0) <= generation) this.observations.set(key, observation);
        // Older overlapping reads cannot overwrite more recent evidence, including negative facts.
        for (const fact of normalized.facts) {
          if ((this.entryGenerations.get(fact.path) || 0) <= generation) {
            this.putFact(fact.path, fact); this.entryGenerations.set(fact.path, generation); this.entryScopes.set(fact.path, { method: query.method, scope });
          }
        }
        if (normalized.state !== "complete") this.reads.delete(key);
        this.trim(); await record();
        return value;
      } catch (error) {
        this.reads.delete(key);
        const observation: Observation = { observationId, generation, epoch, round, method: query.method, scope, basis, binding, startedAt,
          observedAt: new Date(this.now()).toISOString(), reusableUntil: startedAt, state: epoch === this.epoch ? "failed" : "invalidated",
          error: error instanceof Error ? error.message.slice(0, 1000) : "文件查询失败", files: 0, directories: 0, unknown: 0 };
        for (const previous of this.observations.values()) if (previous.method === query.method && previous.generation <= generation
          && JSON.stringify(previous.scope) === JSON.stringify(scope)) previous.state = "invalidated";
        if ((this.observations.get(key)?.generation || 0) <= generation) this.observations.set(key, observation);
        this.trim(); await record();
        throw error;
      }
    })();
    this.reads.set(key, { at: this.now(), epoch, promise });
    return promise;
  }

  async invalidate(reason: string, paths: string[] = []): Promise<void> {
    this.epoch++; this.reads.clear();
    paths = paths.filter(name => safe(name));
    this.invalidations.push({ epoch: this.epoch, paths });
    if (this.invalidations.length > 64) this.invalidations.shift();
    this.invalidatedAt = new Date(this.now()).toISOString(); this.invalidationReason = reason;
    for (const observation of this.observations.values()) {
      const scopes = observation.scope.paths.length ? observation.scope.paths : [observation.scope.relativePath];
      if (!paths.length || paths.some(changed => scopes.some(root => root === "." || root === changed || root.startsWith(changed + "/") || changed.startsWith(root + "/")))) observation.state = "invalidated";
      else observation.epoch = this.epoch;
    }
    for (const listener of this.listeners) { try { listener(reason); } catch { /* A closed viewer cannot block invalidation. */ } }
    await this.persist();
  }
  subscribe(listener: (reason: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Explicit diagnostic flush; normal view publication never waits for directory shard I/O. */
  async flush(): Promise<void> { await this.writing; }
  /** A baseline is an acceleration input, never a completed observation. Its remote cursor must be revalidated. */
  async readBaseline(): Promise<any | undefined> {
    try {
      const file = this.file + ".scope-baseline", stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return;
      const { checksum, ...record } = JSON.parse(await fs.readFile(file, "utf8"));
      if (record.schemaVersion !== 1 || checksum !== hash(record) || record.identity !== this.baselineIdentity()) return;
      return record.value;
    } catch { return; }
  }
  async writeBaseline(value: unknown): Promise<void> {
    const record = { schemaVersion: 1, identity: this.baselineIdentity(), value };
    const text = JSON.stringify({ ...record, checksum: hash(record) });
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) return;
    try { await atomicWriteText(this.file + ".scope-baseline", text, { beforeRename: async () => {
      if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED");
    } }); } catch { /* Next query can always request a reset from the live server. */ }
  }
  private baselineIdentity() { return hash([this.identity.workspace, this.identity.endpointId, this.identity.projectRoot, this.identity.endpointBinding || this.identity.connection]); }
  directoryFile(relative: string): string {
    if (relative !== "." && !safe(relative)) throw Error("FILE_INDEX_PATH_INVALID");
    return path.join(path.dirname(this.file), path.basename(this.file, ".json") + ".directories", hash(relative) + ".json");
  }

  private trim() {
    while (this.entries.size > 60000) { const name = this.entries.keys().next().value!; this.putFact(name, undefined); this.entryGenerations.delete(name); this.entryScopes.delete(name); }
    while (this.observations.size > 64) this.observations.delete(this.observations.keys().next().value!);
    for (const [key, read] of this.reads) if (this.now() - read.at > 2000) this.reads.delete(key);
    while (this.reads.size > 64) this.reads.delete(this.reads.keys().next().value!);
  }
  private content(fact?: IndexedFileFact) {
    if (!fact) return {};
    const { observedAt, observationId, ...value } = fact; return value;
  }
  private putFact(name: string, fact?: IndexedFileFact) {
    const old = this.entries.get(name);
    if (fact) this.entries.set(name, fact); else this.entries.delete(name);
    if (JSON.stringify(this.content(old)) === JSON.stringify(this.content(fact))) return;
    const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ".";
    if (!this.directoryGroups.has(parent)) this.directoryGroups.set(parent, {});
    if (name !== ".") {
      if (fact) this.directoryGroups.get(parent)![name] = this.content(fact);
      else delete this.directoryGroups.get(parent)![name];
    }
    let current = fact?.type === "directory" || old?.type === "directory" ? name : parent;
    while (true) {
      if (!this.directoryGroups.has(current)) this.directoryGroups.set(current, {});
      this.dirtyDirectories.add(current);
      if (current === ".") break;
      const ancestor = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : ".";
      const children = this.directoryChildren.get(ancestor) || new Set<string>(); children.add(current); this.directoryChildren.set(ancestor, children);
      current = ancestor;
    }
  }
  snapshot(includeEntries = true) {
    const observations = [...this.observations.values()], byId = new Map(observations.map(row => [row.observationId, row]));
    return { schemaVersion: 1, identity: this.identity, generation: this.generation, epoch: this.epoch,
      invalidatedAt: this.invalidatedAt, invalidationReason: this.invalidationReason,
      policy: { diskEvidence: "historical-only", maxReuseMs: 2000, reuseRequiresSameRound: true, negativesRequireCompleteLiveScope: true },
      retention: { maxEntries: 60000, maxObservations: 64, entriesAreNotCompleteCoverage: true },
      observations, entries: Object.fromEntries((includeEntries ? [...this.entries] : []).map(([name, row]) => {
        const observation = byId.get(row.observationId);
        return [name, { ...row, validity: observation?.epoch === this.epoch && observation.state === "complete"
          && this.now() <= Date.parse(observation.reusableUntil) ? "same-round-only" : "historical-only" }];
      })) };
  }
  private async persistDirectories(snapshot: any): Promise<any> {
    const groups = this.directoryGroups, refs = this.directoryRefs;
    const dirty = [...this.dirtyDirectories]; this.dirtyDirectories.clear();
    const writes: Array<{ relative: string; file: string; digest: string; text: string }> = [];
    for (const relative of dirty.sort((a, b) => (b === "." ? 0 : b.split("/").length) - (a === "." ? 0 : a.split("/").length) || b.length - a.length)) {
      const entries = groups.get(relative)!, childRefs = Object.fromEntries([...(this.directoryChildren.get(relative) || [])].sort().map(child => [child, refs.get(child)]));
      const facts = Object.values(entries) as any[];
      const summary = { files: facts.filter(row => row.type === "file" && row.presence === "present").length,
        bytes: facts.reduce((total, row) => total + (row.type === "file" && row.presence === "present" ? row.size || 0 : 0), 0),
        unknown: facts.filter(row => row.presence === "unknown").length };
      for (const child of Object.values(childRefs) as any[]) { summary.files += child.summary.files; summary.bytes += child.summary.bytes; summary.unknown += child.summary.unknown; }
      const directory = this.content(this.entries.get(relative));
      const content = { relativeDirectory: relative, directory, entries, children: childRefs, summary };
      const fingerprint = hash(content), file = this.directoryFile(relative);
      refs.set(relative, { file: path.basename(file), fingerprint, summary });
      if (this.directoryDigests.get(relative) !== fingerprint) writes.push({ relative, file, digest: fingerprint, text: JSON.stringify({ schemaVersion: 1,
        identity: this.identity, recordedAt: new Date(this.now()).toISOString(), directoryFingerprint: fingerprint,
        timeDomains: { index: "host-utc", files: this.identity.endpointId === "local" ? "host-filesystem" : "remote-filesystem", crossClockComparisonAllowed: this.identity.endpointId === "local" },
        freshness: "mtime-is-a-hint-live-observation-required", maxDirectChildModifiedAtMs: Math.max(0, ...facts.map(row => row.modifiedAtMs || 0)),
        ...content }) });
    }
    // Independent directory files write concurrently; the root is published only after every shard settles.
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, writes.length) }, async () => {
      while (next < writes.length) {
        const item = writes[next++];
        await atomicWriteText(item.file, item.text, { beforeRename: async () => { if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED"); } });
        this.directoryDigests.set(item.relative, item.digest);
      }
    }));
    const failure = results.find(row => row.status === "rejected") as PromiseRejectedResult | undefined;
    if (failure) { for (const name of dirty) this.dirtyDirectories.add(name); throw failure.reason; }
    const { entries, ...header } = snapshot;
    this.directoryPublication = { layout: { kind: "direct-children-with-child-summaries", directoryRoot: path.basename(path.dirname(this.directoryFile("."))), root: refs.get(".") },
      directoryCount: refs.size, directoryFilesWritten: writes.length, directorySummariesRecomputed: dirty.length };
    return { ...header, ...this.directoryPublication };
  }
  private persist(observationOnly = false): Promise<void> {
    // Index I/O cannot turn a valid filesystem read into a scientific or execution failure.
    this.writing = this.writing.catch(() => {}).then(async () => {
      try {
        if (owners.get(this.file) !== this) return;
        const { entries, ...header } = this.snapshot(false);
        const snapshot: any = observationOnly ? { ...header, ...this.directoryPublication } : await this.persistDirectories(header);
        let serialized = JSON.stringify(snapshot);
        // Keep diagnostic storage bounded without truncating the actual read returned to its consumer.
        while (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024 && Object.keys(snapshot.entries || {}).length) {
          const rows = Object.entries(snapshot.entries); snapshot.entries = Object.fromEntries(rows.slice(Math.ceil(rows.length / 2)));
          snapshot.retention.storageTruncated = true; serialized = JSON.stringify(snapshot);
        }
        if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) {
          snapshot.observations = snapshot.observations.slice(-1); snapshot.retention.storageTruncated = true;
          serialized = JSON.stringify(snapshot);
        }
        while (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024 && snapshot.observations[0]?.scope.paths.length) {
          const scope = snapshot.observations[0].scope; scope.paths = scope.paths.slice(0, Math.floor(scope.paths.length / 2)); scope.pathsTruncated = true;
          serialized = JSON.stringify(snapshot);
        }
        await atomicWriteText(this.file, serialized, { beforeRename: async () => {
          if (owners.get(this.file) !== this) throw Error("FILE_INDEX_CONNECTION_REPLACED");
        } });
      }
      catch { if (owners.get(this.file) === this) console.warn("[SimpleExperiment] 文件索引未能持久化；本轮仍只采用实际查询结果。"); }
    });
    return this.writing;
  }
}

export function normalizeFileIndexResult(value: any, observedAt: string, observationId: string, query?: FileIndexQuery) {
  const facts: IndexedFileFact[] = [];
  let error = typeof value?.error === "string" ? value.error.slice(0, 1000) : "";
  if (!value || value.ok === false || error || value.status === "unknown") return { facts, state: "failed" as const, error: error || "文件查询失败" };
  if (value.executionSource?.manifest) value = { ...value, files: value.executionSource.manifest };
  const method = query?.method || "";
  if (["sync.projectInventory", "sync.projectFileStats", "agent.metadata", "local.metadata", "local.before-operation", "local.code-manifest"].includes(method) && value.files === undefined
    || method === "sync.projectTree" && value.exists !== false && !Array.isArray(value.entries)
    || method === "sync.projectTreeState" && typeof value.exists !== "boolean"
    || method === "files.cleanup.inspect" && (!value.target || typeof value.target !== "object"))
    return { facts, state: "failed" as const, error: "文件查询未返回所需清单或存在性，状态未知" };
  let partial = value.complete === false || value.truncated === true;
  if (value.files !== undefined && (!value.files || typeof value.files !== "object" || Array.isArray(value.files))
    || value.entries !== undefined && !Array.isArray(value.entries)
    || value.unverifiedFiles !== undefined && (!value.unverifiedFiles || typeof value.unverifiedFiles !== "object" || Array.isArray(value.unverifiedFiles)))
    return { facts, state: "failed" as const, error: "文件清单格式无效" };
  const add = (name: string, row: any, directory = false) => {
    if (!safe(name) && name !== ".") { partial = true; return; }
    if (!row || typeof row !== "object") { partial = true; return; }
    const sha256 = typeof row?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : undefined;
    const unknown = row?.status === "unknown" || row?.error;
    facts.push({ path: name, type: directory || row?.directory === true ? "directory" : "file",
      presence: unknown ? "unknown" : row?.exists === false || row?.missing === true ? "absent" : "present",
      size: Number.isFinite(row?.size) ? row.size : undefined, modifiedAtMs: Number.isFinite(row?.modifiedAtMs) ? row.modifiedAtMs : undefined,
      sha256, observedAt, observationId, error: unknown ? String(row.error || "状态未知").slice(0, 1000) : undefined,
      device: typeof row?.device === "string" ? row.device : undefined, inode: typeof row?.inode === "string" ? row.inode : undefined,
      changedAtMs: Number.isFinite(row?.changedAtMs) ? row.changedAtMs : undefined });
  };
  if (value.files && typeof value.files === "object" && !Array.isArray(value.files)) for (const [name, row] of Object.entries(value.files)) add(name, row);
  if (query?.method === "files.cleanup.inspect" && value.target) {
    const name = query.paths?.length === 1 ? query.paths[0] : undefined;
    const absolute = String(value.target.absolutePath || "").replaceAll(String.fromCharCode(92), "/");
    if (name && (value.target.relativePath === name || absolute.endsWith("/" + name)))
      add(name, value.target, value.target.type === "directory" || query.targetType === "directory");
    else { partial = true; error = "删除目标观察与查询范围不一致"; }
  } else if (value.target?.relativePath) add(value.target.relativePath, value.target, value.target.type === "directory");
  if (["sync.projectTree", "sync.projectTreeState"].includes(query?.method || "") && typeof value.exists === "boolean")
    add(query?.relativePath || ".", { ...value, directory: true }, true);
  if (value.directories && typeof value.directories === "object") for (const [name, row] of Object.entries(value.directories)) add(name, row, true);
  for (const row of Array.isArray(value.entries) ? value.entries : []) add(row.path, row, row.directory === true);
  for (const [name, reason] of Object.entries(value.unverifiedFiles || {})) { add(name, { status: "unknown", error: reason }); partial = true; }
  for (const name of Array.isArray(value.missing) ? value.missing : []) add(name, { missing: true });
  if (facts.some(row => row.presence === "unknown")) partial = true;
  return { facts, state: partial ? "partial" as const : "complete" as const, error };
}

const indexes = new Map<string, ProjectFileIndex>();
/**
 * The one local observation identity. Every entry point observing the local project must join through
 * this helper: the storage file only keys on endpointId+projectRoot, so any second literal identity
 * with a different property set builds a second instance for the same file and steals `owners`,
 * turning concurrent reads on the other instance into FILE_INDEX_CONNECTION_REPLACED.
 */
export function localFileIndexIdentity(workspaceRoot: string): FileIndexIdentity {
  return { workspace: workspaceRoot, endpointId: "local", projectRoot: workspaceRoot, connection: "local:" + process.pid, endpointBinding: "local" };
}
export function projectFileIndex(identity: FileIndexIdentity, storageRoot: string): ProjectFileIndex {
  const key = hash([storageRoot, identity]);
  let index = indexes.get(key);
  if (!index || owners.get(index.file) !== index) { index = new ProjectFileIndex(identity, storageRoot); indexes.set(key, index); }
  // No disk snapshot is loaded as live evidence after process or connection restart.
  while (indexes.size > 128) indexes.delete(indexes.keys().next().value!);
  return index;
}
export function sftpFileIndexQuery(method: string, params: any): FileIndexQuery | undefined {
  if (!READS.has(method)) return undefined;
  return { method, relativePath: params.relativePath || ".", paths: params.scopePaths || params.paths || (params.target?.relativePath ? [params.target.relativePath] : []), recursive: method === "sync.projectInventory" ? params.recursive !== false : params.recursive === true,
    metadataOnly: method !== "sync.projectInventory" || params.metadataOnly === true, signal: params.signal,
    round: params.fileIndexRound, targetType: params.target?.type, binding: { purpose: params.inventoryPurpose || (params.metadataOnly === true || method !== "sync.projectInventory" ? "file-status" : "artifact-or-code-confirmation"), ...params.fileIndexBinding } };
}

/** Exact paths only. An unspecified transfer scope requests a shallow root observation, never a full scan. */
export function fileOperationIndexPaths(params: any, local = false): string[] {
  const manifest = params.manifest?.files || params.manifest;
  const candidates = [...(params.scopePaths || []), ...(params.relativePaths || []), ...(params.paths || []),
    ...(params.relativePath ? [params.relativePath] : []),
    ...(Array.isArray(manifest) ? manifest : manifest && typeof manifest === "object" ? Object.keys(manifest) : []),
    ...(Array.isArray(params.files) ? params.files.map((row: any) => typeof row === "string" ? row : row?.remoteName) : []),
    ...(Array.isArray(params.entries) ? params.entries.map((row: any) => local ? row?.localRelativePath : row?.remotePath) : [])];
  return [...new Set(candidates.filter((name): name is string => safe(name)))].sort();
}

export async function readLocalFileIndexPaths(root: string, paths: string[]) {
  const canonical = await fs.realpath(root), files: Record<string, any> = {};
  const names = paths.length ? [...new Set(paths)] : ["."];
  if (names.some(relative => relative !== "." && !safe(relative))) throw Error("FILE_INDEX_PATH_INVALID");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => { while (next < names.length) {
    const relative = names[next++];
    try {
      const full = path.resolve(canonical, relative), physical = await fs.realpath(full), rel = path.relative(canonical, physical);
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw Error("FILE_INDEX_PATH_OUTSIDE_ROOT");
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error("FILE_INDEX_TYPE_UNSUPPORTED");
      files[relative] = { directory: stat.isDirectory(), size: stat.size, modifiedAtMs: stat.mtimeMs, changedAtMs: stat.ctimeMs,
        device: String(stat.dev), inode: String(stat.ino) };
    } catch (error: any) {
      files[relative] = error?.code === "ENOENT" ? { exists: false } : { status: "unknown", error: error?.message || "文件属性读取失败" };
    }
  } }));
  return { ok: true, files };
}
