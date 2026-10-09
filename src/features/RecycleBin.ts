export interface DeletedExperimentRecord {
  archiveKey: string;
  experimentId?: string;
  state: "deleted" | "delete_failed" | "residue" | "delete_requested";
  deletedAt?: string;
  targetPaths: string[];
  residue?: Array<{ endpoint: string; path: string; error?: string }>;
}

export function recycleView(records: DeletedExperimentRecord[]): DeletedExperimentRecord[] {
  return records.filter((item) => ["deleted", "delete_failed", "residue", "delete_requested"].includes(item.state))
    .sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
}

export function recycleAuditMarkdown(records: DeletedExperimentRecord[]): string {
  return [
    "ArchiveKey | State | DeletedAt | Residue",
    "--- | --- | --- | ---",
    ...recycleView(records).map((item) => [item.archiveKey, item.state, item.deletedAt || "", item.residue?.map((r) => `${r.endpoint}:${r.path}`).join("<br>") || ""].join(" | ")),
  ].join("\n");
}
