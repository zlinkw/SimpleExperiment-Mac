import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectFileIndex } from "../features/ProjectFileIndex";

export type PlanExecutionSource = { digest: string; manifest: Record<string, { size: number; sha256: string }> };
const resolving = new WeakMap<object, Promise<PlanExecutionSource | undefined>>();
const digest = (manifest: PlanExecutionSource["manifest"]) => createHash("sha256").update(JSON.stringify(
  Object.keys(manifest).sort().map(key => [key, { size: manifest[key].size, sha256: manifest[key].sha256 }]))).digest("hex");
/** Single source of truth for manifest self-verification (also consumed by the C3 HEAD binding). */
export const planExecutionSourceDigest = digest;
/** Same relative-path safety rules verifyLocalPlanSource enforces before touching the filesystem. */
export function planManifestPathSafe(relative: string): boolean {
  return Boolean(relative) && !relative.startsWith("/") && !/[:\\\x00-\x1f]/.test(relative) && !relative.split("/").some(p => !p || p === "." || p === "..");
}
export const supportsPlanCodeScope = (h: any, workerId: string) => h.lastWorkerProbes?.[workerId]?.capabilities?.endpoints?.planCodeScope === 1;
/** This filter is for automatic execution preparation; manual transfer scopes keep their own semantics. */
export function runSourceManifest(manifest: Record<string, any>) {
  const generated = new Set(["work_dirs","work_dir","results","result","runs","logs","log","outputs","output","tmp","temp","__pycache__",".cache","cache",".pytest_cache",".mypy_cache",".ruff_cache","wandb","tensorboard"]);
  return Object.fromEntries(Object.entries(manifest).filter(([file])=>{
    const parts=file.toLowerCase().split("/");
    return !parts.slice(0,-1).some(p=>generated.has(p)) && !/\.(?:pyc|pyo|log|pending|writing)$/.test(file.toLowerCase());
  }));
}
/** Verify every manifest file without widening a file into its top-level directory. */
export function codeInventoryBatches(manifest: Record<string, unknown>): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [], bytes = 2;
  for (const file of Object.keys(manifest).sort()) {
    const size = Buffer.byteLength(JSON.stringify(file), "utf8") + 1;
    if (size + 2 > 1048576) throw Error("CODE_INVENTORY_PATH_TOO_LARGE");
    if (batch.length && (batch.length >= 5000 || bytes + size > 1048576)) {
      batches.push(batch); batch = []; bytes = 2;
    }
    batch.push(file); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function query(plan: any, source?: PlanExecutionSource) {
  return { projectId: plan.projectId, planFile: plan.planFile, planRevision: plan.revision, codeFingerprint: plan.codeFingerprint,
    ...(source ? { executionSource: source } : {}) };
}
function response(plan: any, value: any): PlanExecutionSource {
  if (value?.ok !== true || value.compatible !== true || value.readOnly !== true || value.projectId !== plan.projectId
    || value.planFile !== plan.planFile || value.planRevision !== plan.revision || value.codeFingerprint !== plan.codeFingerprint)
    throw Error(value?.error || "PLAN_SOURCE_QUERY_IDENTITY_MISMATCH");
  const source = value.executionSource;
  if (!source?.manifest || Object.keys(source.manifest).length > 4096 || source.digest !== digest(source.manifest)
    || source.manifest[plan.planFile]?.sha256 !== plan.revision) throw Error("PLAN_SOURCE_BASELINE_INVALID");
  return source;
}
async function inspect(h: any, workerId: string, plan: any, source?: PlanExecutionSource, signal?: AbortSignal) {
  const options = { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) };
  const target = h.workerActionTargets?.().find((row: any) => row.id === workerId);
  const index = target && h.projectFileObservationIndex?.(h.sftpServerOptions?.(target));
  const load = async () => {
    const value = await h.client.getWorkerPlanCodeScope(workerId, query(plan, source), options);
    response(plan, value); // Invalid identity or digest is never published into the shared index.
    return value;
  };
  const value = index ? await index.read({ method: "plan.source", paths: source ? Object.keys(source.manifest) : [plan.planFile],
    binding: { projectId: plan.projectId, runId: plan.id || "", revision: plan.revision, sourceDigest: source?.digest || "" }, signal: options.signal }, load) : await load();
  return response(plan, value);
}
/** Frozen source hashes are execution inputs. All destination observations are queried again. */
export async function resolvePlanExecutionSource(h: any, plan: any, signal?: AbortSignal): Promise<PlanExecutionSource | undefined> {
  if (plan.executionSource) {
    if (plan.executionSource.digest !== digest(plan.executionSource.manifest)
      || plan.executionSource.manifest[plan.planFile]?.sha256 !== plan.revision) throw Error("PLAN_SOURCE_BASELINE_INVALID");
    return plan.executionSource;
  }
  const active = resolving.get(plan); if (active) return active;
  const candidates = h.workerActionTargets().filter((w: any) => supportsPlanCodeScope(h, w.id) && h.lastWorkerProbes[w.id]?.status === "ok");
  if (!candidates.length) return undefined;
  const controller = new AbortController();
  const joined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const request = Promise.any(candidates.map(async (worker:any)=>{
    try { return await inspect(h,worker.id,plan,undefined,joined); }
    catch(error:any){throw Error(worker.id+": "+String(error.message||error));}
  })).then(source=>plan.executionSource=source).catch((error:any)=>{
    throw Error("所需源码无法核实："+(error.errors||[error]).map((e:any)=>String(e.message||e)).join("；"));
  }).finally(()=>{controller.abort();resolving.delete(plan);});
  resolving.set(plan,request);return request;
}
export async function verifyWorkerPlanSource(h: any, workerId: string, plan: any, signal?: AbortSignal) {
  if (!supportsPlanCodeScope(h, workerId)) throw Error(workerId + "：请更新 Agent/Scheduler 以按 PLAN 依赖核实源码；未另行派发。");
  const source = await resolvePlanExecutionSource(h, plan, signal);
  if (!source) throw Error("PLAN_SOURCE_ORIGINAL_HASH_UNAVAILABLE");
  const checked = await inspect(h, workerId, plan, source, signal);
  if (checked.digest !== source.digest) throw Error("PLAN_SOURCE_BASELINE_CHANGED");
  return source;
}
export async function verifyLocalPlanSource(root: string, source: PlanExecutionSource, index?: ProjectFileIndex) {
  const load = async () => {
  const canonical = await fs.realpath(root);
  for (const [relative, expected] of Object.entries(source.manifest)) {
    if (!planManifestPathSafe(relative)) throw Error("PLAN_SOURCE_PATH_INVALID");
    let file = canonical;
    for (const part of relative.split("/")) {
      file = path.join(file, part);
      if ((await fs.lstat(file)).isSymbolicLink()) throw Error("PLAN_SOURCE_LINK: " + relative);
    }
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== expected.size || stat.size > 2 * 1024 * 1024
      || createHash("sha256").update(await fs.readFile(file)).digest("hex") !== expected.sha256)
      throw Error("PLAN_SOURCE_CHANGED: " + relative + "；仅核实本 PLAN 所需源码和配置，未删除或派发。");
  }
  return { files: source.manifest };
  };
  if (index) await index.read({ method: "plan.local-source", paths: Object.keys(source.manifest), binding: { sourceDigest: source.digest } }, load);
  else await load();
}
/** Admission checks cannot turn transfer inventory changes into execution version conflicts. */
export async function inspectPlanCodeSlots(h: any, queue: any, workers: any[], signal?: AbortSignal) {
  const reads: Map<string,any> = h.planCodeScopeReads ||= new Map();
  let accepting = true;
  const requests: Promise<any>[] = [];
  const pending = queue.plans.filter((p: any) => p.projectId && p.resultPathPolicy === "declared" && p.jobs.some((j: any) => j.status === "pending" && !j.commandId));
  for (const plan of pending) {
    for (const w of workers) if (w.online && !supportsPlanCodeScope(h,w.workerId) && w.codeFingerprint !== plan.codeFingerprint)
      (w.codeScopeErrors ||= {})[plan.id] = w.workerId + "：请更新 Agent/Scheduler（planCodeScope=1）以核实本 PLAN 源码；无需重建 PLAN 或重跑其他 job。";
    const ready = workers.filter(w => w.online && supportsPlanCodeScope(h, w.workerId)
      && (w.gpuSlots?.length || w.idleGpuIds?.length || plan.schedulingMode === "server_prequeue"));
    if (!ready.length) continue;
    for(const w of ready){
      (w.codeScopeErrors ||= {})[plan.id] = w.workerId+"：源码核实进行中。";
      const target=h.workerActionTargets().find((r:any)=>r.id===w.workerId);
      const key=JSON.stringify([plan.projectId,plan.id,plan.revision,plan.codeFingerprint,w.workerId,target]);
      let entry=reads.get(key);
      if(!entry||entry.at&&Date.now()-entry.at>2000){
        entry={at:0,promise:undefined};
        entry.promise=verifyWorkerPlanSource(h,w.workerId,plan,signal).then(source=>({source}),error=>({error})).then(value=>{entry.at=Date.now();return value;});
        reads.set(key,entry);
      }
      requests.push(entry.promise.then(({source,error}:any)=>{
        if(!accepting)return;
        if(error)w.codeScopeErrors[plan.id]=w.workerId+": "+String(error.message||error);
        else{plan.executionSource=source;delete w.codeScopeErrors[plan.id];(w.compatiblePlans ||= []).push(plan.id);}
      }));
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled(requests),new Promise(resolve=>{timer=setTimeout(resolve,350);})]); }
  finally { accepting=false;if(timer)clearTimeout(timer); }
  for(const [key,entry] of reads)if(entry.at&&Date.now()-entry.at>2000)reads.delete(key);
}
