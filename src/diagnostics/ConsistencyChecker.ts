export interface ConsistencyIssue {
  severity: "info" | "warning" | "error";
  kind: string;
  archiveKey?: string;
  runKey?: string;
  endpoint?: "local" | "hub" | "worker";
  message: string;
  suggestedAction?: string;
}

export function checkClusterConsistency(input: {
  traces: Array<Record<string, any>>;
  records: Array<Record<string, any>>;
  tombstones: Set<string>;
  serverIdentityCandidates: (server: any) => string[];
  servers: any[];
}): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const serverCandidates = new Set((input.servers || []).flatMap(input.serverIdentityCandidates));
  for (const row of input.traces || []) {
    const archiveKey = String(row.archive_key || row.global_job_id || row.run_id || "");
    const paths = [row.hub_job_dir, row.worker_job_dir, row.native_job_dir, row.hub_console_log].map((item) => String(item || "")).filter(Boolean);
    if (input.tombstones.has(archiveKey) || paths.some((path) => input.tombstones.has(path))) {
      issues.push({
        severity: "error",
        kind: "tombstone_visible",
        archiveKey,
        message: "Deleted tombstone still appears in ordinary archive list.",
        suggestedAction: "Refresh traces or run delete reconciler; do not sync/download this entry.",
      });
    }
    const source = String(row.worker_id || row.worker_host || "").trim().toLowerCase().replace(/^ssh-config:/, "").replace(/^[^@]+@/, "");
    if (source && !serverCandidates.has(source)) {
      issues.push({
        severity: "warning",
        kind: "source_server_unmatched",
        archiveKey,
        endpoint: "worker",
        message: `Cannot match sourceServer: ${source}`,
        suggestedAction: "Check SSH config alias/server identity mapping.",
      });
    }
  }
  for (const record of input.records || []) {
    const state = String(record.state || "");
    const archiveKey = String(record.archiveKey || "");
    if (["delete_requested", "deleting", "delete_failed", "deleted"].includes(state)) continue;
    const manifestKey = String(record.manifest?.archiveKey || "");
    if (archiveKey && manifestKey && archiveKey !== manifestKey) {
      issues.push({
        severity: "warning",
        kind: "archive_key_mismatch",
        archiveKey,
        message: `Registry archiveKey differs from manifest archiveKey: ${manifestKey}`,
        suggestedAction: "Rebuild artifact registry from manifest metadata.",
      });
    }
  }
  return issues;
}