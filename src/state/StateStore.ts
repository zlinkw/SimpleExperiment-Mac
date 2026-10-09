import * as fs from "fs/promises";
import * as path from "path";
import * as fsNode from "fs";

const atomicWriteQueues = new Map<string, Promise<void>>();

export type StateReadResult<T> =
  | { ok: true; value: T; migrated?: boolean }
  | { ok: false; error: string; lastKnownGood?: T };

export type AtomicWriteOptions = {
  /** Recheck optimistic-concurrency/ownership gates before every publication attempt. */
  beforeRename?: () => Promise<void>;
  /** Larger durable journals may briefly be held by Windows indexers; ordinary state keeps its short retry limit. */
  renameRetryBudgetMs?: number;
};

export async function atomicWriteText(file: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  const resolved = path.resolve(file);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = atomicWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writeFixedSlot(resolved, text, options));
  atomicWriteQueues.set(key, current);
  try {
    await current;
  } finally {
    if (atomicWriteQueues.get(key) === current) atomicWriteQueues.delete(key);
  }
}

async function writeFixedSlot(file: string, text: string, options: AtomicWriteOptions): Promise<void> {
  const budget = options.renameRetryBudgetMs;
  if (budget != null && (!Number.isFinite(budget) || budget < 0 || budget > 5000)) throw new Error("状态重命名重试预算无效");
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true });
  const staging = `${file}.writing`;
  let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    existing = await fs.lstat(staging);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`状态暂存路径不是普通文件：${staging}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const flags = fsNode.constants.O_WRONLY | (fsNode.constants.O_NOFOLLOW || 0);
  const handle = await fs.open(staging, existing ? flags : flags | fsNode.constants.O_CREAT | fsNode.constants.O_EXCL, 0o600);
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(staging);
    const changedIdentity = Boolean(current.dev && current.ino && opened.dev && opened.ino &&
      (current.dev !== opened.dev || current.ino !== opened.ino));
    const knownIdentityChanged = Boolean(existing?.dev && existing.ino && opened.dev && opened.ino &&
      (existing.dev !== opened.dev || existing.ino !== opened.ino));
    if (!opened.isFile() || opened.nlink > 1 || current.isSymbolicLink() || !current.isFile() || current.nlink > 1 || changedIdentity || knownIdentityChanged)
      throw new Error(`状态暂存文件身份发生变化：${staging}`);
    await handle.truncate(0);
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesWritten) throw new Error(`状态暂存写入未前进：${staging}`);
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const deadline = Date.now() + (budget || 0);
  for (let attempt = 0; ; attempt += 1) {
    // A delayed rename must not bypass a queue generation or disk-version change.
    // Guard failures are not sharing violations and must not enter the rename retry loop.
    await options.beforeRename?.();
    try {
      await fs.rename(staging, file);
      break;
    } catch (error: any) {
      if (!error || !["EACCES", "EPERM", "EBUSY"].includes(error.code) || attempt >= 5 && (budget == null || Date.now() >= deadline) || attempt >= 25) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(250, 20 * (2 ** attempt), budget == null ? 250 : deadline - Date.now()))));
    }
  }
  if (process.platform !== "win32") {
    let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      directory = await fs.open(parent, "r");
      await directory.sync();
    } catch {
      // Directory fsync is not supported by every filesystem.
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }
}

export async function readJsonState<T>(
  file: string,
  validate: (value: any) => value is T,
  migrate: (value: any) => T,
  lastKnownGood?: T,
): Promise<StateReadResult<T>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (validate(parsed)) return { ok: true, value: parsed };
    const migrated = migrate(parsed);
    if (validate(migrated)) return { ok: true, value: migrated, migrated: true };
    return { ok: false, error: "schema validation failed", lastKnownGood };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), lastKnownGood };
  }
}

export async function writeJsonState<T extends { schemaVersion?: number }>(
  file: string,
  value: T,
  schemaVersion: number,
  validate: (value: any) => value is T,
): Promise<void> {
  const next = { ...value, schemaVersion };
  if (!validate(next)) throw new Error(`state validation failed: ${file}`);
  await atomicWriteText(file, JSON.stringify(next, null, 2));
}
