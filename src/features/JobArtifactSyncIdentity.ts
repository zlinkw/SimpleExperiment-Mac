import { createHash } from "crypto";
export type ArtifactTransferMember = { retentionKey: string; planId: string; commandId: string; files: Record<string, string> };
/** Shared transport owns the complete member set, never impersonates its first job. */
export function jobArtifactBatchIdentity(members: readonly ArtifactTransferMember[]): { retentionKey: string; generation: string } {
  if (!members.length) throw Error("ARTIFACT_BATCH_IDENTITY_REQUIRED");
  const paths = new Map<string, string>(), identities = new Map<string, string>();
  const canonical = members.map(member => {
    if (!member.retentionKey || !member.planId || !member.commandId) throw Error("ARTIFACT_BATCH_IDENTITY_REQUIRED");
    const files = Object.keys(member.files).sort().map(file => {
      const sha = String(member.files[file]).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Error("ARTIFACT_BATCH_HASH_REQUIRED");
      if (paths.has(file) && paths.get(file) !== sha) throw Error("ARTIFACT_BATCH_PATH_CONFLICT: " + file);
      paths.set(file, sha); return [file, sha];
    });
    const record = [member.retentionKey, member.planId, member.commandId, files];
    const encoded = JSON.stringify(record), prior = identities.get(member.retentionKey);
    if (prior && prior !== encoded) throw Error("ARTIFACT_BATCH_IDENTITY_CONFLICT");
    identities.set(member.retentionKey, encoded); return record;
  });
  const unique = [...new Map(canonical.map(row => [String(row[0]), row])).values()].sort((a,b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  if (unique.length === 1) return { retentionKey: members[0].retentionKey,
    generation: jobArtifactRunGeneration(members[0].planId, members[0].commandId, members[0].files) };
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { retentionKey: "job-artifacts-batch:" + hash(unique.map(row => row[0])), generation: hash(unique) };
}

/**
 * Staging identity of one completed job's artifact sync (task ui-plan-gpu-progress-20261024 r5).
 * The retentionKey reuses the EXACT five-tuple the dedicated plan chain already sends
 * (syncDistributedJobArtifacts), so both chains treat one job as one logical source. The caller
 * must pass the real queue identity; nothing here is derived from sourceId or outputDir.
 */
export function jobArtifactRetentionKey(planFile: string, index: number, caseName: unknown, seed: unknown): string {
  return JSON.stringify(["job-artifacts", planFile, index, caseName, seed]);
}

/**
 * Generation = run identity (plan.id + job.commandId) bound to the frozen source manifest
 * (canonical sorted path + source SHA256, hex lower-cased). Retries and reloads over identical
 * source content resume their own generation; a new dispatch, a new plan run, a changed hash or a
 * changed file set always opens a new one. Destination-side sync progress is not an input, so a
 * partially synced destination never changes the generation of identical inputs. The 64-hex output
 * passes the receiver's transferScope64 unchanged, and the receiver reuses one generation across
 * the retry/extra batches of one run (staged-tar-receive claim: own-generation slots resume).
 */
export function jobArtifactRunGeneration(planId: string, commandId: string, sourceFiles: Record<string, string>): string {
  const manifest = Object.keys(sourceFiles).sort().map(file => [file, String(sourceFiles[file]).toLowerCase()]);
  return createHash("sha256").update(JSON.stringify(["job-artifact-run", planId, commandId, manifest])).digest("hex");
}

/**
 * Staging identity of the shared version-retain/merge lanes (task ui-plan-gpu-progress-20261024 r112).
 * These lanes previously sent no retentionKey/generation, so every attempt fell back to the shared
 * "project-files"/"directory:*" scope with a fresh per-transfer generation (simple-sftp
 * stagedLogicalKey/claim), which jams the two-generation window with TRANSFER_STAGE_PENDING once the
 * first committed pair occupies it — proven live on nwpu3 (d-47be3d71… = sha256(["project-files",0])
 * and d-008f3730… lane both held fully by this same source's committed generations).
 * The same-input rule mirrors jobArtifactRunGeneration: an identical batch path set with an identical
 * frozen source manifest reuses ONE generation, so a retry resumes its own slot (receiver
 * own-generation resume) instead of forcing a third generation; any changed path or SHA opens a new
 * one. The retentionKey carries no source/worker/node identity — it is the sorted deduplicated batch
 * path list, making one logical batch one logical source. Job artifact chain parameters are untouched.
 * r117 (Q5 fix): a scope entry may be a DIRECTORY (manual directory retain legacy.ts:11368 and
 * directory restore :11449 pass the directory path together with an inventory keyed by its contained
 * files). The manifest therefore covers the complete frozen selection: a direct inventory entry is one
 * item; otherwise every inventory descendant "<scope>/…" is an item. Inventory entries outside the
 * scope never enter the hash (they must not open generations), and a directory's descendant SHA,
 * additions or removals always open a new generation. Pure file scopes hash exactly as before.
 */
export function syncScopeStagingIdentity(scopePaths: readonly string[],
  sourceFiles: Record<string, string | { sha256?: unknown }>): { retentionKey: string; generation: string } {
  const scope = [...new Set(scopePaths.map(file => String(file)))].sort();
  const shaOf = (value: string | { sha256?: unknown } | undefined): string =>
    typeof value === "string" ? value.toLowerCase() : String(value?.sha256 ?? "").toLowerCase();
  const frozen = new Map<string, string>();
  for (const scopePath of scope) {
    const descendants = Object.keys(sourceFiles).filter(file => file.startsWith(scopePath + "/")).sort();
    if (descendants.length) for (const file of descendants) frozen.set(file, shaOf(sourceFiles[file]));
    else frozen.set(scopePath, shaOf(sourceFiles[scopePath]));
  }
  const manifest = [...frozen].sort((left, right) => (left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1));
  return { retentionKey: "sync-scope-retain:" + JSON.stringify(scope),
    generation: createHash("sha256").update(JSON.stringify(["sync-scope-retain", scope, manifest])).digest("hex") };
}

/**
 * Structured TRANSFER_STAGE_PENDING stage block (SimpleSFTP 0.2.113 schemaVersion 1; task
 * se-stage-block-visibility-release-20261026). The block is ADDITIVE evidence that travels with the
 * ORIGINAL readable error text — the UI summary and every backend release binding consume ONLY these
 * structured values, never a path parsed out of error text. Values are whitelist-sanitized at every
 * persistence point so a queue file can never carry arbitrary shapes from an error object; identity
 * and generations keep their FULL 64-hex values here (a UI may abbreviate for display only).
 */
export type JobArtifactStageBlockSlot = {
  slot: string; path: string; generation: string; status: string;
  createdAt: number; terminalAt: number; updatedAt: number;
  timeSource: string | null; ageMs: number | null; locked: boolean; protectedReason: string | null;
};
export type JobArtifactStageBlock = {
  schemaVersion: 1; code: "TRANSFER_STAGE_PENDING";
  destination: { id: string; profile: string; host: string };
  scope: string; lane: number; identity: string; incomingGeneration: string;
  slots: JobArtifactStageBlockSlot[]; releaseCandidate: boolean;
};

function stageBlockHex(value: unknown): string {
  const text = String(value ?? "");
  return /^[0-9a-f]{64}$/.test(text) ? text : "";
}

/** Whitelist projection of one slot row; unknown fields never enter the queue file. */
function stageBlockSlot(row: unknown): JobArtifactStageBlockSlot {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const time = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    slot: String(item.slot ?? "").slice(0, 128), path: String(item.path ?? "").slice(0, 4096),
    generation: stageBlockHex(item.generation), status: String(item.status ?? "").slice(0, 64),
    createdAt: time(item.createdAt), terminalAt: time(item.terminalAt), updatedAt: time(item.updatedAt),
    timeSource: typeof item.timeSource === "string" ? item.timeSource.slice(0, 128) : null,
    ageMs: Number.isInteger(item.ageMs) ? item.ageMs as number : null,
    locked: item.locked === true,
    protectedReason: typeof item.protectedReason === "string" ? item.protectedReason.slice(0, 512) : null,
  };
}

/**
 * Sanitizes a raw stage block (error.stageBlock or error.apiData.stageBlock) into the persisted
 * shape. Anything that is not a schemaVersion-1 TRANSFER_STAGE_PENDING block with the expected
 * skeleton returns undefined — the caller then persists no structured evidence and shows no release
 * entry (text compatibility alone). Never guesses: a block without structured fields stays text-only.
 */
export function sanitizeArtifactStageBlock(raw: unknown): JobArtifactStageBlock | undefined {
  const block = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!block || Number(block.schemaVersion) !== 1 || String(block.code) !== "TRANSFER_STAGE_PENDING") return undefined;
  const destination = block.destination && typeof block.destination === "object"
    ? block.destination as Record<string, unknown> : {};
  return {
    schemaVersion: 1, code: "TRANSFER_STAGE_PENDING",
    destination: { id: String(destination.id ?? "").slice(0, 256), profile: String(destination.profile ?? "").slice(0, 256),
      host: String(destination.host ?? "").slice(0, 256) },
    scope: String(block.scope ?? "").slice(0, 4096), lane: Number(block.lane) === 1 ? 1 : 0,
    identity: stageBlockHex(block.identity), incomingGeneration: stageBlockHex(block.incomingGeneration),
    slots: (Array.isArray(block.slots) ? block.slots : []).map(stageBlockSlot),
    releaseCandidate: block.releaseCandidate === true,
  };
}

/** Structured evidence of one SimpleSFTP error, either attachment point, sanitized or absent. */
export function artifactStageBlockFromError(error: unknown): JobArtifactStageBlock | undefined {
  const item = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (!item) return undefined;
  const apiData = item.apiData && typeof item.apiData === "object" ? item.apiData as Record<string, unknown> : undefined;
  return sanitizeArtifactStageBlock(item.stageBlock) || sanitizeArtifactStageBlock(apiData?.stageBlock);
}

/**
 * Real-time capability gate for the "释放旧文件占用" entry (ruling Q6 + final-review P1-2): SE
 * enables it ONLY when the live capabilities carry the COMPLETE release-chain contract together —
 * every method the controlled chain later calls (stagedSlots/preview/confirm/execute/status/
 * isolatedMaintenanceDelete) plus each method's ruled options, never inferred from a version
 * number. confirm must prove the exact-batch digest binding and isolatedMaintenanceDelete the
 * registered-token-only + plugin-derived-delete-set + receipt-required guarantees, or SE could
 * reach isolation before discovering the deletion capability is missing. files.cleanup.status
 * carries no declared method options on the receiving side (it is the read-only receipt poll), so
 * only its method presence is required there. userConfirmedSlotRelease (SimpleSFTP 0.2.114) is the
 * early-release half of that guarantee: the controlled chain always binds requireExpired:false, so
 * without the descriptor proving it the backend would refuse a young slot right after the user
 * confirmed — an old SimpleSFTP (0.2.113 and earlier, no such option) is the intended fail-closed:
 * the release entry stays hidden and the plain readable error stays visible, with no fallback.
 */
export function stagedSlotReleaseEvidenceReady(capabilities: unknown): boolean {
  const shared = capabilities && typeof capabilities === "object" ? capabilities as Record<string, unknown> : undefined;
  const methods = Array.isArray(shared?.methods) ? shared!.methods as unknown[] : [];
  const options = shared?.methodOptions && typeof shared.methodOptions === "object"
    ? shared.methodOptions as Record<string, Record<string, unknown>> : {};
  const staged = options["files.cleanup.stagedSlots"] || {}, fpsync = options["sync.serverToServerFpsync"] || {},
    preview = options["files.cleanup.preview"] || {}, execute = options["files.cleanup.execute"] || {},
    confirm = options["files.cleanup.confirm"] || {}, isolatedDelete = options["files.cleanup.isolatedMaintenanceDelete"] || {};
  return ["files.cleanup.stagedSlots", "files.cleanup.preview", "files.cleanup.confirm", "files.cleanup.execute",
    "files.cleanup.status", "files.cleanup.isolatedMaintenanceDelete"].every(method => methods.includes(method))
    && staged.expiredCommittedReclaim === 1 && staged.structuredBlockEvidence === 1 && staged.releaseConfirmationCount === 1
    && fpsync.claimScopedExpiredReclaim === 1 && fpsync.stageBlockEvidence === 1
    && preview.backgroundIsolatedDelete === 1 && execute.isolationCompletionReceipt === 1
    && confirm.exactBatchDigest === true
    && isolatedDelete.registeredIsolationTokenOnly === 1 && isolatedDelete.pluginDerivedDeleteSet === 1
    && isolatedDelete.isolationCompletionReceiptRequired === 1
    && isolatedDelete.userConfirmedSlotRelease === 1;
}
