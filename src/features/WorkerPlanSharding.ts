import { createHash } from "crypto";

export interface WorkerPlanShard {
  workerId: string;
  experimentIndices: number[];
  shardRevision: string;
}

export interface WorkerPlanShardSet {
  schemaVersion: 1;
  planRevision: string;
  workerSetRevision: string;
  workerIds: string[];
  experimentIndices: number[];
  shards: WorkerPlanShard[];
}

export function createWorkerPlanShardSet(
  planRevision: string,
  workerIds: readonly string[],
  experimentIndices: readonly number[],
): WorkerPlanShardSet {
  const revision = String(planRevision || "").trim();
  if (!revision) throw new Error("Plan revision is required for deterministic Worker sharding.");
  const workers = normalizedWorkerIds(workerIds);
  if (workers.length < 2) throw new Error("Worker pool sharding requires at least two unique Worker IDs.");
  const indices = normalizedExperimentIndices(experimentIndices);
  if (!indices.length) throw new Error("Plan validation returned no experiment indices to shard.");
  const workerSetRevision = createWorkerSetRevision(revision, workers);
  const assigned = new Map(workers.map((workerId) => [workerId, [] as number[]]));
  for (const experimentIndex of indices) {
    const workerId = rendezvousWorker(revision, experimentIndex, workers);
    assigned.get(workerId)?.push(experimentIndex);
  }
  const shards = workers.map((workerId) => {
    const workerIndices = assigned.get(workerId) || [];
    return {
      workerId,
      experimentIndices: workerIndices,
      shardRevision: digest({ planRevision: revision, workerSetRevision, workerId, experimentIndices: workerIndices }),
    };
  });
  return { schemaVersion: 1, planRevision: revision, workerSetRevision, workerIds: workers, experimentIndices: indices, shards };
}

export function workerPlanShardSetMatches(
  value: unknown,
  planRevision: string,
  workerIds: readonly string[],
): value is WorkerPlanShardSet {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkerPlanShardSet>;
  return item.schemaVersion === 1
    && item.planRevision === String(planRevision || "").trim()
    && item.workerSetRevision === createWorkerSetRevision(item.planRevision, workerIds)
    && Array.isArray(item.shards);
}

export function createWorkerSetRevision(planRevision: string, workerIds: readonly string[]): string {
  const revision = String(planRevision || "").trim();
  if (!revision) throw new Error("Plan revision is required for Worker set identity.");
  const workers = normalizedWorkerIds(workerIds);
  if (!workers.length) throw new Error("At least one Worker ID is required for Worker set identity.");
  return digest({ planRevision: revision, workerIds: workers });
}

function normalizedWorkerIds(values: readonly string[]): string[] {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizedExperimentIndices(values: readonly number[]): number[] {
  return [...new Set((values || []).map(Number).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
}

function rendezvousWorker(planRevision: string, experimentIndex: number, workerIds: readonly string[]): string {
  return workerIds.reduce((best, candidate) => {
    const candidateScore = createHash("sha256").update(`${planRevision}\0${experimentIndex}\0${candidate}`).digest("hex");
    const bestScore = createHash("sha256").update(`${planRevision}\0${experimentIndex}\0${best}`).digest("hex");
    return candidateScore > bestScore ? candidate : best;
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
