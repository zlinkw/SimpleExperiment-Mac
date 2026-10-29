import { createHash } from "node:crypto";
import * as path from "node:path";

type Profile = { schemaVersion: 1; root: string; values: Record<string, any> };
type Entry = { profile: Profile; legacy: boolean; pending: Promise<void> };
const profiles = new WeakMap<object, Map<string, Entry>>();
function identity(root: string) {
  if (!root) return "";
  const normalized = path.resolve(root).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function state(context: any, root: string): { key: string; entry: Entry } {
  const owner = identity(root);
  if (!owner) throw new Error("PROJECT_CONNECTION_REQUIRED：当前窗口没有受支持的项目，不能保存或启用项目连接。");
  const key = "simpleExperimentMac.projectConnections.v1." + createHash("sha256").update(owner).digest("hex");
  let cached = profiles.get(context);
  if (!cached) { cached = new Map(); profiles.set(context, cached); }
  let entry = cached.get(key);
  if (!entry) {
    const saved = context.workspaceState.get(key);
    const legacyOwner = context.workspaceState.get("simpleExperimentMac.projectConnections.legacyOwner");
    if (saved && (saved.schemaVersion !== 1 || saved.root !== owner || !saved.values || typeof saved.values !== "object"))
      throw new Error("PROJECT_CONNECTION_OWNER_MISMATCH：项目连接归属不匹配，未借用其他项目配置。");
    entry = { profile: saved ? structuredClone(saved) : { schemaVersion: 1, root: owner, values: {} },
      legacy: !saved && (legacyOwner === owner || !legacyOwner && !cached.size) && Boolean(context.workspaceState.get("simpleExperimentMac.localApiPort")), pending: Promise.resolve() };
    if (!legacyOwner && !cached.size) entry.pending = entry.pending.then(() => context.workspaceState.update("simpleExperimentMac.projectConnections.legacyOwner", owner));
    cached.set(key, entry);
    if (!saved) persist(context, key, entry);
  }
  return { key, entry };
}
function persist(context: any, key: string, entry: Entry) {
  const snapshot = structuredClone(entry.profile);
  entry.pending = entry.pending.then(() => context.workspaceState.update(key, snapshot));
  // Reads can seed a legacy profile synchronously. Explicit saves still await and
  // surface this same rejection; a failed migration never becomes a global write.
  void entry.pending.catch(() => undefined);
  return entry.pending;
}
export function readProjectConnectionValue(context: any, root: string, key: string): any {
  if (!root) return undefined;
  const { key: storageKey, entry } = state(context, root);
  if (!Object.hasOwn(entry.profile.values, key) && entry.legacy) {
    entry.profile.values[key] = structuredClone(context.globalState.get(key));
    persist(context, storageKey, entry);
  }
  return entry.profile.values[key];
}
export async function saveProjectConnectionValues(context: any, root: string, values: Record<string, any>) {
  const { key, entry } = state(context, root);
  entry.profile = { ...entry.profile, values: { ...entry.profile.values, ...structuredClone(values) } };
  await persist(context, key, entry);
}
