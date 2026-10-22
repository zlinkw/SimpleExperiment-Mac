// v1.10 single-round batched read-only observation (contract: recovery-observe-v110-contract.md).
// One public recovery/recheck call owns one ObservationRound. Groups are merged by stable node
// identity, canonical root and the exact target set; results live only in this round's memory.
// A allocates the total two-read budget: one group may run readConcurrency 2, two concurrent
// groups get 1 each. A never falls back to N single remote queries when the capability is missing.
import { randomBytes } from "node:crypto";

export const BATCH_OBSERVATION_MAX_TARGETS = 5000;
export const BATCH_OBSERVATION_UPGRADE_CODE = "SFTP_BATCH_OBSERVATION_UPGRADE_REQUIRED";
export const BATCH_OBSERVATION_UPGRADE_MESSAGE = "当前 SimpleSFTP 不支持批量只读观察 observeBatch；请更新配套插件后重新查询。未重新执行任何文件操作，本轮不会退回逐文件远端查询。";

export type ObserveTarget = { key: string; relativePath: string; type: "file" | "directory";
  backendToken?: string; backendIndex?: number; device?: string | number; inode?: string | number; isolationRelativePath?: string };
export type ObservationEntry = { key: string; relativePath?: string; type?: string;
  status?: "present" | "gone" | "replaced";
  target?: { relativePath?: string; type?: string; absolutePath?: string; missing?: boolean; device?: string | number; inode?: string | number } | null;
  state?: string; executors?: unknown[]; executorsChecked?: boolean;
  isolationStatus?: "present" | "gone" | "replaced" | "unknown"; isolationChecked?: boolean;
  error?: { code?: string; message?: string } };
export type GroupOutcome = { identityKey: string; sourceKey: string; keys: string[]; byKey: Map<string, ObservationEntry>;
  missingKeys: string[]; rootIdentity?: unknown; upgrade?: boolean; failure?: { code: string; message: string } };

export type ObservationRound = { id: string; closed: boolean; inflight: number; queue: Array<() => void>;
  plannedGroups: number; outcomes: GroupOutcome[]; entryOwners: Map<string, GroupOutcome>;
  sftp: (method: string, params: unknown) => Promise<unknown>; digest: (value: unknown) => string; timeoutMs: number };

export function createObservationRound(config: { sftp: (method: string, params: unknown) => Promise<unknown>;
  digest: (value: unknown) => string; timeoutMs: number }): ObservationRound {
  return { id: "obs-" + randomBytes(12).toString("hex"), closed: false, inflight: 0, queue: [], plannedGroups: 0,
    outcomes: [], entryOwners: new Map(), sftp: config.sftp, digest: config.digest, timeoutMs: config.timeoutMs };
}

/** Expanded entries: each target plus its paired isolation path travel in the same chunk. */
const expandedWeight = (target: ObserveTarget) => 1 + (target.isolationRelativePath ? 1 : 0);
function chunkObservationTargets(targets: ObserveTarget[]): ObserveTarget[][] {
  const chunks: ObserveTarget[][] = []; let current: ObserveTarget[] = []; let weight = 0;
  for (const target of targets) { const next = expandedWeight(target);
    if (current.length && (weight + next > BATCH_OBSERVATION_MAX_TARGETS || current.length >= BATCH_OBSERVATION_MAX_TARGETS)) { chunks.push(current); current = []; weight = 0; }
    current.push(target); weight += next; }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Total two in-flight reads across the whole round; readConcurrency follows the planned group count. */
async function withReadBudget<T>(round: ObservationRound, run: () => Promise<T>): Promise<T> {
  while (round.inflight >= 2) await new Promise<void>(resolve => round.queue.push(() => resolve()));
  round.inflight++;
  try { return await run(); } finally { round.inflight--; const next = round.queue.shift(); if (next) next(); }
}

async function requestChunk(round: ObservationRound, node: Record<string, unknown>, targets: ObserveTarget[], rootIdentity?: unknown)
  : Promise<{ entries: ObservationEntry[]; missing: string[]; rootIdentity?: unknown; upgrade?: boolean; failure?: { code: string; message: string } }> {
  const request: Record<string, unknown> = { node, observationId: round.id,
    readConcurrency: round.plannedGroups === 1 ? 2 : 1, targets };
  if (rootIdentity !== undefined) request.rootIdentity = rootIdentity;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: any = await Promise.race([
      round.sftp("files.cleanup.observeBatch", { ...request, signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = Object.assign(new Error("批量只读观察超时；可重新查询，未重新执行文件操作。"), { apiData: { code: "CLEANUP_QUERY_TIMEOUT" } });
        controller.abort(error); reject(error); }, round.timeoutMs); }),
    ]);
    const code = String(response?.apiData?.code || response?.code || "");
    if (code === "UNKNOWN_ACTION" || code === "UPDATE_REQUIRED")
      return { entries: [], missing: targets.map(t => t.key), upgrade: true };
    if (response?.ok !== true || response?.observationId !== round.id
      || response?.capabilities?.batchCleanupObservation !== 1 || !Array.isArray(response?.observations))
      return { entries: [], missing: targets.map(t => t.key),
        ...(response?.capabilities?.batchCleanupObservation !== 1 ? { upgrade: true }
          : { failure: { code: "UNVERIFIED_RESPONSE", message: "批量观察回包与本轮请求不一致，按未知处理。" } }) };
    if (rootIdentity !== undefined && round.digest(response.rootIdentity ?? null) !== round.digest(rootIdentity))
      return { entries: [], missing: targets.map(t => t.key), failure: { code: "ROOT_IDENTITY_CHANGED", message: "批量观察的根身份与本轮冻结身份不一致，按未知处理。" } };
    const byKey = new Map<string, ObservationEntry>(); const poisoned = new Set<string>();
    for (const entry of response.observations) {
      if (!entry || typeof entry.key !== "string" || !targets.some(t => t.key === entry.key)) continue;
      if (byKey.has(entry.key)) { poisoned.add(entry.key); continue; }
      if ((typeof entry.relativePath === "string" && entry.relativePath !== targets.find(t => t.key === entry.key)!.relativePath)
        || (typeof entry.type === "string" && entry.type !== targets.find(t => t.key === entry.key)!.type)) { poisoned.add(entry.key); byKey.set(entry.key, { key: entry.key, error: { code: "OBSERVATION_MISMATCH" } }); continue; }
      byKey.set(entry.key, entry);
    }
    const missing = targets.filter(t => !byKey.has(t.key) || poisoned.has(t.key)).map(t => t.key);
    return { entries: [...byKey.values()], missing, rootIdentity: response.rootIdentity };
  } catch (error: any) {
    const code = String(error?.apiData?.code || error?.code || "NODE_UNREACHABLE");
    if (code === "UNKNOWN_ACTION" || code === "UPDATE_REQUIRED")
      return { entries: [], missing: targets.map(t => t.key), upgrade: true };
    return { entries: [], missing: targets.map(t => t.key),
      failure: { code, message: String(error?.message || error) } };
  } finally { if (timer) clearTimeout(timer); }
}

/** One observation group is bound to the FULL request identity: stable node, frozen root and every
 * frozen target fact. C1 rule: two operations may share a row id, but a different backend token,
 * index, path, device/inode or isolation mapping is different evidence and must be read separately. */
function sourceIdentity(digest: (value: unknown) => string, node: Record<string, unknown>, rootIdentity?: unknown): string {
  return digest({ kind: node.kind ?? null, id: node.id, host: node.host ?? null, user: node.user ?? null,
    port: node.port ?? null, root: node.root ?? null, rootIdentity: rootIdentity === undefined ? null : rootIdentity });
}
function targetFacts(digest: (value: unknown) => string, target: ObserveTarget): string {
  return digest({ key: target.key, relativePath: target.relativePath, type: target.type,
    backendToken: target.backendToken ?? null, backendIndex: target.backendIndex ?? null,
    device: target.device === undefined ? null : String(target.device), inode: target.inode === undefined ? null : String(target.inode),
    isolationRelativePath: target.isolationRelativePath ?? null });
}

/** One grouped observation for one full request identity; identical facts share inside the round, and a
 * subset may reuse a superset only when every target's full facts match exactly — never by key name alone. */
export async function observeRound(round: ObservationRound, node: Record<string, unknown> & { root?: string },
  targets: ObserveTarget[], options: { rootIdentity?: unknown } = {}): Promise<GroupOutcome> {
  const sourceKey = sourceIdentity(round.digest, node, options.rootIdentity);
  const facts = targets.map(target => targetFacts(round.digest, target)).sort();
  const identityKey = sourceKey + ":" + round.digest(facts);
  const cached = round.outcomes.find(o => o.identityKey === identityKey);
  if (cached) return cached;
  const keys = targets.map(t => t.key).sort();
  if (facts.length) {
    const owners = facts.map(fact => round.entryOwners.get(sourceKey + ":" + fact));
    const owner = owners[0];
    if (owner && owners.every(owned => owned === owner)) return { ...owner, keys }; // entry views share one evidence map
  }
  const outcome: GroupOutcome = { identityKey, sourceKey, keys, byKey: new Map(), missingKeys: [] };
  if (round.closed) { outcome.failure = { code: "ROUND_CLOSED", message: "本轮观察已结束，旧轮不再采集。" }; return outcome; }
  round.plannedGroups = Math.max(round.plannedGroups, chunkObservationTargets(targets).length);
  let upgrade = false; const failures: Array<{ code: string; message: string }> = [];
  for (const chunk of chunkObservationTargets(targets)) {
    const result = await withReadBudget(round, () => requestChunk(round, node, chunk, options.rootIdentity));
    for (const entry of result.entries) outcome.byKey.set(entry.key, entry);
    outcome.missingKeys.push(...result.missing);
    if (result.upgrade) upgrade = true;
    if (result.failure) failures.push(result.failure);
    if (result.rootIdentity !== undefined && outcome.rootIdentity === undefined) outcome.rootIdentity = result.rootIdentity;
  }
  outcome.upgrade = upgrade || undefined;
  outcome.failure = failures[0];
  round.outcomes.push(outcome);
  for (const fact of facts) round.entryOwners.set(sourceKey + ":" + fact, outcome);
  return outcome;
}
