import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Stats, Dirent } from "node:fs";
import { constants } from "node:fs";
import { atomicWriteText } from "../state/StateStore";
import { scopeInventoryPathAllowed } from "./SyncScopeStatus";
import { LocalMetadataChanges } from "./LocalMetadataChanges";

type Row = { directory: boolean; size: number; modifiedAtMs: number; changedAtMs: number; device: string; inode: string };
const same = (a: Row | undefined, b: Row) => !!a && a.directory === b.directory && a.size === b.size
  && a.modifiedAtMs === b.modifiedAtMs && a.changedAtMs === b.changedAtMs && a.device === b.device && a.inode === b.inode;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parent = (name: string) => name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ".";
const safe = (name: string) => name === "." || !/[\\:\x00-\x1f]/.test(name) && name.length <= 4096 && name.split("/").every(p => p && p !== "." && p !== "..");
const fact = (s: Stats): Row => ({ directory: s.isDirectory(), size: s.isDirectory() ? 0 : s.size,
  modifiedAtMs: s.mtimeMs, changedAtMs: s.ctimeMs, device: String(s.dev), inode: String(s.ino) });

async function parallel<T>(values: T[], run: (value: T) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(16, values.length) }, async () => {
    while (next < values.length) await run(values[next++]);
  }));
  const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failure) throw failure.reason;
}

/** Local Windows volumes use a live notification cursor between bounded reconciliations.
 * Reloads, gaps and unsupported filesystems revalidate saved identities. Saved negatives are never proof. */
export class IncrementalLocalMetadata {
  private rows = new Map<string, Row>();
  private loaded = false;
  private sequence = 0;
  private journalBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly changes = new LocalMetadataChanges();
  private published?: { files: Record<string, any>; directories: Record<string, any>; unverifiedFiles: Record<string, string> };
  constructor(private readonly root: string, private readonly file?: string) {}

  invalidate() { this.changes.invalidate(); }
  dispose() { this.changes.close(); }

  read(signal?: AbortSignal, report = (_stage: string) => {}) {
    const result = this.queue.catch(() => {}).then(async () => {
      for (let attempt = 0; ; attempt++) try { return await this.scan(signal, report); }
      catch (error) { if (attempt >= 2 || signal?.aborted || !String(error).includes("LOCAL_INDEX_DIRECTORY_CHANGED")) throw error; }
    }).catch(error => {
      this.changes.invalidate(); this.rows.clear(); this.sequence = 0; this.journalBytes = 0; throw error;
    });
    this.queue = result;
    return result;
  }

  private async scan(signal?: AbortSignal, report = (_stage: string) => {}) {
    signal?.throwIfAborted();
    const root = await fs.realpath(this.root), rootStat = await fs.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (process.platform === "win32" ? path.resolve(root).toLowerCase() !== path.resolve(this.root).toLowerCase() : path.resolve(root) !== path.resolve(this.root)))
      throw Error("LOCAL_INDEX_ROOT_UNSAFE");
    const identity = { root, device: String(rootStat.dev), inode: String(rootStat.ino), policy: 1 };
    await this.changes.start(root, JSON.stringify(identity), identity.device);
    const cursor = await this.changes.snapshot();
    let restored = false;
    if (!this.loaded) {
      this.loaded = true;
      if (this.file) try {
        const stat = await fs.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error("LOCAL_INDEX_CACHE_INVALID");
        const text = await fs.readFile(this.file, "utf8");
        if (!text.endsWith("\n")) throw Error("LOCAL_INDEX_JOURNAL_INCOMPLETE");
        for (const line of text.trimEnd().split("\n")) {
          const { checksum, ...record } = JSON.parse(line);
          if (checksum !== digest(record) || record.schema !== 1 || JSON.stringify(record.identity) !== JSON.stringify(identity)
            || record.sequence !== this.sequence + 1 || !Array.isArray(record.changes)) throw Error("LOCAL_INDEX_JOURNAL_INVALID");
          for (const [name, row] of record.changes) {
            if (typeof name !== "string" || !safe(name) || row && (typeof row.directory !== "boolean" || !Number.isFinite(row.size)
              || row.size < 0 || !Number.isFinite(row.modifiedAtMs) || !Number.isFinite(row.changedAtMs)
              || typeof row.device !== "string" || typeof row.inode !== "string")) throw Error("LOCAL_INDEX_CACHE_INVALID");
            if (row) this.rows.set(name, row); else this.rows.delete(name);
          }
          if (this.rows.size > 60000) throw Error("LOCAL_INDEX_ENTRY_LIMIT");
          this.sequence = record.sequence;
        }
        for (const [name] of this.rows) if (name !== "." && (!this.rows.get(parent(name))?.directory || !scopeInventoryPathAllowed(name, this.rows.get(name)!.directory)))
          throw Error("LOCAL_INDEX_CACHE_PARENT_INVALID");
        if (!this.rows.get(".")?.directory) throw Error("LOCAL_INDEX_CACHE_ROOT_INVALID");
        this.journalBytes = stat.size; restored = true;
      } catch { this.rows.clear(); this.sequence = 0; this.journalBytes = 0; }
    }
    const before = this.rows, rows = new Map(before), validated = new Map<string, Row>();
    const native = cursor.native && before.size > 0;
    if (native && !cursor.dirty.size && this.published && same(before.get("."), fact(rootStat))) {
      await this.changes.complete(cursor, false);
      signal?.throwIfAborted();
      report(`原生增量校验 · 已复用 ${before.size} 项 · 校验 1 项 · 读取 0 个变化目录`);
      return { ...this.published, observedAt: new Date().toISOString(), acceleration: { restored, reusedEntries: before.size,
        statCalls: 1, enumeratedDirectories: 0, changedEntries: 0, mode: "native-directory-deltas" } };
    }
    const childDirectories = new Map<string, string[]>();
    const childrenByParent = new Map<string, Set<string>>();
    for (const [name, row] of before) if (name !== ".") {
      const p = parent(name), children = childrenByParent.get(p) || new Set<string>(); children.add(name); childrenByParent.set(p, children);
      if (row.directory) { const list = childDirectories.get(p) || []; list.push(name); childDirectories.set(p, list); }
    }
    let statCalls = 0, enumeratedDirectories = 0, reusedEntries = 0, listedEntries = 0;
    let lastReport = -Infinity;
    const mode = native ? "原生增量校验" : before.size ? "实时身份复核" : "首次建立索引";
    const progress = (force = false) => { if (force || performance.now() - lastReport >= 100) {
      lastReport = performance.now(); report(`${mode} · 已复用 ${reusedEntries} 项 · 校验 ${statCalls} 项 · 读取 ${enumeratedDirectories} 个变化目录`);
    } };
    const full = (name: string) => name === "." ? root : path.join(root, ...name.split("/"));
    const check = async (name: string): Promise<Row | undefined> => {
      signal?.throwIfAborted(); statCalls++;
      try {
        const s = await fs.lstat(full(name));
        if (s.isSymbolicLink() || String(s.dev) !== identity.device || !s.isDirectory() && !s.isFile()) throw Error("LOCAL_INDEX_UNSAFE_ENTRY: " + name);
        return fact(s);
      } catch (error: any) { if (name !== "." && error.code === "ENOENT") return undefined; throw error; }
    };
    const remove = (name: string) => {
      for (const child of childrenByParent.get(name) || []) remove(child);
      childrenByParent.delete(name); childrenByParent.get(parent(name))?.delete(name); rows.delete(name);
    };
    const forced = new Set<string>();
    const nativePaths = new Set<string>(["."]);
    if (native) for (const name of cursor.dirty) {
      let p = parent(name); forced.add(p); nativePaths.add(p);
      if (before.get(name)?.directory) { forced.add(name); nativePaths.add(name); }
      while (p !== ".") { p = parent(p); nativePaths.add(p); }
    }
    if (native) reusedEntries = before.size;
    const pending = native ? [...nativePaths].sort((a, b) => a.split("/").length - b.split("/").length) : ["."];
    progress(true);
    const visited = new Set<string>();
    const checkedFiles = new Set<string>();
    while (pending.length) {
      const names = pending.splice(0, 16);
      await parallel(names, async name => {
        if (visited.has(name)) return;
        visited.add(name);
        if (visited.size > 10000) throw Error("LOCAL_INDEX_DIRECTORY_LIMIT");
        const current = await check(name), old = before.get(name);
        if (!current) { remove(name); return; }
        if (!current.directory) { remove(name); rows.set(name, current); return; }
        if (await fs.realpath(full(name)) !== full(name)) throw Error("LOCAL_INDEX_DIRECTORY_UNSAFE: " + name);
        validated.set(name, current); rows.set(name, current);
        if (!old?.directory || !same(old, current) || forced.has(name)) {
          enumeratedDirectories++;
          const found = new Set<string>();
          const directory = await fs.opendir(full(name), { bufferSize: 128 });
          try {
            const children: Array<[string, Dirent]> = [];
            for await (const entry of directory) {
              if (++listedEntries > 100000) throw Error("LOCAL_INDEX_ENTRY_LIMIT");
              const child = name === "." ? entry.name : name + "/" + entry.name;
              if (!safe(child)) throw Error("LOCAL_INDEX_PATH_INVALID");
              if (scopeInventoryPathAllowed(child, entry.isDirectory())) children.push([child, entry]);
            }
            await parallel(children, async ([child, entry]) => {
              const saved = before.get(child);
              const reusable = native && saved && !cursor.dirty.has(child) && saved.directory === entry.isDirectory()
                && (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink();
              const row = reusable ? saved : await check(child);
              if (!row) throw Error("LOCAL_INDEX_DIRECTORY_CHANGED: " + name);
              found.add(child);
              if (rows.get(child)?.directory && !row.directory) remove(child);
              rows.set(child, row);
              const siblings = childrenByParent.get(name) || new Set<string>(); siblings.add(child); childrenByParent.set(name, siblings);
              if (row.directory && (!native || !same(before.get(child), row))) pending.push(child);
              else checkedFiles.add(child);
            });
          } finally { await directory.close().catch(() => {}); }
          for (const child of childrenByParent.get(name) || []) if (!found.has(child)) remove(child);
        } else {
          if (!native) { reusedEntries++; pending.push(...(childDirectories.get(name) || [])); }
        }
        progress();
      });
    }
    // A directory mtime does not detect edits to existing files, nor changes made while the host was closed.
    // Fresh batched stats are mandatory without a durable, continuous filesystem journal.
    if (!native) await parallel([...before].filter(([name, row]) => !row.directory && rows.has(name) && !checkedFiles.has(name)).map(([name]) => name), async name => {
      const row = await check(name);
      if (!row) rows.delete(name);
      else if (row.directory) throw Error("LOCAL_INDEX_TYPE_CHANGED: " + name);
      else { if (same(before.get(name), row)) reusedEntries++; rows.set(name, row); }
      progress();
    });
    await parallel([...validated], async ([name, row]) => {
      const current = await check(name);
      if (!current || !same(row, current)) throw Error("LOCAL_INDEX_DIRECTORY_CHANGED: " + name);
    });
    signal?.throwIfAborted();
    await this.changes.complete(cursor, !native);
    if (rows.size > 60000) throw Error("LOCAL_INDEX_ENTRY_LIMIT");
    if ([...rows.values()].filter(row => !row.directory).length > 50000) throw Error("LOCAL_INDEX_FILE_LIMIT");
    const changes: Array<[string, Row | null]> = [];
    for (const [name, row] of rows) if (!same(before.get(name), row)) {
      changes.push([name, row]); if (native && before.has(name)) reusedEntries--;
    }
    for (const name of before.keys()) if (!rows.has(name)) { changes.push([name, null]); if (native) reusedEntries--; }
    this.rows = rows;
    if (this.file && (changes.length || !this.sequence)) try {
      const compact = !this.sequence || this.sequence >= 64 || this.journalBytes > 16 * 1024 * 1024;
      const record = { schema: 1, identity, sequence: compact ? 1 : this.sequence + 1, changes: compact ? [...rows] : changes };
      const text = JSON.stringify({ ...record, checksum: digest(record) }) + "\n";
      if (compact) await atomicWriteText(this.file, text);
      else {
        const handle = await fs.open(this.file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0));
        try {
          const opened = await handle.stat(), current = await fs.lstat(this.file);
          if (!current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino)
            throw Error("LOCAL_INDEX_JOURNAL_UNSAFE");
          await handle.writeFile(text, "utf8"); await handle.sync();
        } finally { await handle.close(); }
      }
      this.sequence = record.sequence; this.journalBytes = (compact ? 0 : this.journalBytes) + Buffer.byteLength(text);
    } catch { this.sequence = 0; this.journalBytes = 0; }
    const files: Record<string, any> = {}, directories: Record<string, any> = {};
    for (const [name, { directory, ...row }] of rows) (directory ? directories : files)[name] = { ...row, modifiedAtMs: Math.floor(row.modifiedAtMs) };
    this.published = { files, directories, unverifiedFiles: {} };
    progress(true);
    return { ...this.published, observedAt: new Date().toISOString(),
      acceleration: { restored, reusedEntries, statCalls, enumeratedDirectories, changedEntries: changes.length,
        mode: native ? "native-directory-deltas" : "live-stat-reconciliation" } };
  }
}

const indexes = new Map<string, IncrementalLocalMetadata>();
export function incrementalLocalMetadata(root: string, file?: string) {
  const key = JSON.stringify([path.resolve(root), file]);
  let index = indexes.get(key);
  if (!index) { index = new IncrementalLocalMetadata(root, file); indexes.set(key, index); }
  while (indexes.size > 32) { const key = indexes.keys().next().value!; indexes.get(key)!.dispose(); indexes.delete(key); }
  return index;
}
