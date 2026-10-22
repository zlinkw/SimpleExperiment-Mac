import type { ScopeObservation, ScopeStatus } from "./SyncScopeTree";

export type MetadataFile = { size: number; modifiedAtMs: number; changedAtMs?: number; device?: string; inode?: string; contentRevision?: string };
export type MetadataInventory = { ok?: boolean; error?: string; status?: string; complete?: boolean; truncated?: boolean; files: Record<string, MetadataFile>; unverifiedFiles?: Record<string, string> };
export type ScopeIndexProgress = { endpointId: string; state: "reading" | "complete" | "partial" | "failed"; detail: string; files?: number };
type Endpoint = { id: string; read: (report: (stage: string) => void) => Promise<MetadataInventory> };

/** Each completed endpoint publishes independently; pending/failed endpoints never prove absence. */
export async function queryScopeMetadata(endpoints: Endpoint[], signal?: AbortSignal,
  report: (stage: string, progress?: ScopeIndexProgress) => void = () => {}, publish: (statuses: Record<string, ScopeStatus>) => void = () => {},
  receive: (id: string, inventory?: MetadataInventory, error?: string) => void = () => {}) {
  const inventories: Record<string, MetadataInventory> = {}, unavailable = new Map(endpoints.map(({ id }) => [id, "正在读取"]));
  const build = () => buildScopeMetadataStatuses(endpoints.map(({ id }) => id), inventories, unavailable);
  await Promise.all(endpoints.map(async ({ id, read }) => {
    try {
      const reading = (detail: string) => { if (!signal?.aborted) report(`${id}：${detail}`, { endpointId: id, state: "reading", detail }); };
      reading("正在读取递归文件信息");
      const inventory = await read(reading);
      signal?.throwIfAborted();
      if (inventory?.ok === false || inventory?.error || inventory?.status === "unknown") throw new Error(inventory.error || "文件信息查询失败");
      if (inventory.complete === false || inventory.truncated === true) throw new Error("文件清单未完整读取，不能确认文件缺失");
      if (!inventory?.files || typeof inventory.files !== "object" || Array.isArray(inventory.files)) throw new Error("文件信息清单无效");
      for (const [name, file] of Object.entries(inventory.files)) {
        if (name.startsWith("/") || /[\\\x00:]/.test(name) || name.split("/").some(p => !p || p === "." || p === "..")
          || !file || !Number.isFinite(file.size) || file.size < 0 || !Number.isFinite(file.modifiedAtMs)) throw new Error("文件信息清单包含无效路径或属性");
      }
      if (inventory.unverifiedFiles && (typeof inventory.unverifiedFiles !== "object" || Array.isArray(inventory.unverifiedFiles)
        || Object.values(inventory.unverifiedFiles).some(reason => typeof reason !== "string" || !reason))) throw new Error("未读取路径清单无效");
      inventories[id] = inventory; unavailable.delete(id);
      receive(id, inventory);
      const files = Object.keys(inventory.files).length, unread = Object.keys(inventory.unverifiedFiles || {}).length;
      const detail = `已读取 ${files} 个文件${unread ? ` · ${unread} 处未核实` : " · 索引完成"}`;
      report(`${id}：${detail}`, { endpointId: id, state: unread ? "partial" : "complete", detail, files });
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.set(id, error instanceof Error ? error.message : String(error));
      receive(id, undefined, unavailable.get(id));
      const detail = unavailable.get(id)!;
      report(`${id}：${detail}`, { endpointId: id, state: "failed", detail });
    }
    if (!signal?.aborted) publish(build());
  }));
  signal?.throwIfAborted();
  return build();
}

export function buildScopeMetadataStatuses(ids: string[], inventories: Record<string, MetadataInventory>, unavailable: Map<string, string>) {
  unavailable = new Map(unavailable);
  for (const id of ids) if (!inventories[id] && !unavailable.has(id)) unavailable.set(id, "未收到本轮文件清单");
  const paths = new Set(Object.values(inventories).flatMap(row => [...Object.keys(row.files), ...Object.keys(row.unverifiedFiles || {})]));
  const statuses: Record<string, ScopeStatus> = {};
  const folders = new Map<string, { total: number; different: number; missing: number; unknown: number; pending: number; copies: NonNullable<ScopeStatus["copies"]> }>();
  for (const name of [...paths].sort()) {
    const metadata: Record<string, ScopeObservation> = {};
    const present: string[] = [], missing: string[] = [], unknown: string[] = [];
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const inventory = inventories[id], file = inventory?.files[name];
      const uncertain = unavailable.get(id) || (!inventory ? "未收到本轮文件清单" : "") || Object.entries(inventory?.unverifiedFiles || {}).find(([p]) => p === "." || p === name || name.startsWith(p + "/"))?.[1];
      if (uncertain) { unknown.push(id); metadata[id] = { status: "unknown", error: uncertain }; }
      else if (!file) { missing.push(id); metadata[id] = { status: "absent" }; }
      else {
        present.push(id); metadata[id] = { status: "present", directory: false, ...file };
        const key = String(file.size); groups.set(key, [...(groups.get(key) || []), id]);
      }
    }
    const different = groups.size > 1;
    // Timestamps are hints, never evidence that bytes differ or that equal sizes mean equal contents.
    const timeOnly = !different && new Set(present.map(id => metadata[id].modifiedAtMs)).size > 1;
    const contentPending = timeOnly && !missing.length && !unknown.length;
    const reading = unknown.filter(id => metadata[id].error === "正在读取"), failed = unknown.filter(id => metadata[id].error !== "正在读取");
    const detail = [missing.length ? `确认缺失：${missing.join("、")}` : "", different ? "文件大小不同" : "", timeOnly ? "仅修改时间不同，内容待比较" : "", reading.length ? `索引未完成：${reading.join("、")}` : "", failed.length ? `查询失败或未核实：${failed.join("、")}` : "", "仅比较文件信息，内容未比较"].filter(Boolean).join(" · ");
    statuses[name] = { basis: "metadata", state: missing.length || different ? "different" : unknown.length || contentPending || ids.length < 2 ? "unknown" : "same", detail, metadata,
      issueSignature: missing.length || different || unknown.length ? JSON.stringify({ basis: "metadata", missing, groups: [...groups.values()].sort((a, b) => a.join().localeCompare(b.join())), unknown }) : undefined };
    const parents = [".", ...name.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))];
    for (const parent of parents) {
      const row = folders.get(parent) || { total: 0, different: 0, missing: 0, unknown: 0, pending: 0, copies: {} };
      row.total++; if (different) row.different++; if (missing.length) row.missing++; if (unknown.length) row.unknown++; if (contentPending) row.pending++;
      for (const id of ids) {
        const copy = row.copies[id] ||= { modifiedAtMs: 0, present: 0, missing: 0, needsSync: 0, conflict: 0, unverified: 0 };
        if (unknown.includes(id)) copy.unverified++;
        else if (missing.includes(id)) copy.missing++;
        else { copy.present++; copy.modifiedAtMs = Math.max(copy.modifiedAtMs, metadata[id].modifiedAtMs || 0); if (different) copy.needsSync++; }
      }
      folders.set(parent, row);
    }
  }
  if (!folders.size) folders.set(".", { total: 0, different: 0, missing: 0, unknown: 0, pending: 0, copies: {} });
  const reading = [...unavailable].filter(([, reason]) => reason === "正在读取").map(([id]) => id);
  const failed = [...unavailable].filter(([, reason]) => reason !== "正在读取").map(([id]) => id);
  const unavailableDetail = [reading.length ? "索引未完成：" + reading.join("、") : "", failed.length ? "查询失败：" + failed.join("、") : ""].filter(Boolean).join("；");
  for (const [folder, row] of folders) statuses[folder] = {
    basis: "metadata", state: row.missing || row.different ? "different" : unavailable.size || row.unknown || row.pending || ids.length < 2 ? "unknown" : "same",
    detail: `递归文件信息${unavailable.size ? "（" + unavailableDetail + "，仅汇总已读结果）" : ""}：${row.total} 个文件 · 缺失 ${row.missing} · 差异 ${row.different} · 未知 ${row.unknown}${row.pending ? " · 待比较内容 " + row.pending : ""} · 内容未比较${unavailable.size ? " · " + [...unavailable].map(([id, error]) => id + "：" + error).join("；") : ""}`,
    copies: row.copies, unverified: unavailable.size > 0 || row.unknown > 0,
  };
  return statuses;
}
