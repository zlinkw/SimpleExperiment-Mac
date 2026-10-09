/**
 * EvidenceCollector — 从 Results.ts / PlanArchive.ts 提取证据归档逻辑
 */

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type CryptoMod = { createHash: (alg: string) => { update(text: string): { digest(enc: string): string } } };

export interface EvidenceItem { kind: "result" | "checkpoint" | "log" | "config" | "env"; path: string; sha256?: string; size?: number; mtime?: string; valid?: boolean; }
export interface EvidenceBundle { runKey: string; planFile?: string; items: EvidenceItem[]; complete: boolean; missing: string[]; collectedAt: string; }

function sha256(text: string): string {
  const c = tryRequire<CryptoMod>("crypto");
  if (c) return c.createHash("sha256").update(text).digest("hex");
  return `hash_${text.length}`;
}

export function collectEvidence(runKey: string, files: Record<string, string>, planFile?: string): EvidenceBundle {
  const items: EvidenceItem[] = Object.entries(files ?? {}).map(([path, content]) => {
    const kind: EvidenceItem["kind"] = /\.csv$/i.test(path) ? "result" : /(checkpoint|ckpt)/i.test(path) ? "checkpoint" : /\.log$/i.test(path) ? "log" : /(config\.ya?ml|\.json$)/i.test(path) ? "config" : "env";
    return { kind, path, sha256: sha256(String(content).slice(0, 4096)), size: String(content).length, mtime: new Date().toISOString(), valid: true };
  });
  const hasResult = items.some((i) => i.kind === "result");
  const hasConfig = items.some((i) => i.kind === "config");
  const missing: string[] = [];
  if (!hasResult) missing.push("result_csv");
  if (!hasConfig) missing.push("config_snapshot");
  return { runKey, planFile, items, complete: missing.length === 0, missing, collectedAt: new Date().toISOString() };
}

export function validateBundle(bundle: EvidenceBundle): { ok: boolean; issues: Array<{ severity: "warning" | "critical"; message: string }> } {
  const issues: Array<{ severity: "warning" | "critical"; message: string }> = [];
  if (!bundle.items.length) issues.push({ severity: "critical", message: "证据为空" });
  if (bundle.missing.length) issues.push({ severity: "critical", message: `缺失证据: ${bundle.missing.join(", ")}` });
  for (const item of bundle.items) if (item.valid === false) issues.push({ severity: "warning", message: `证据无效: ${item.path}` });
  if (bundle.planFile && !bundle.items.some((i) => i.kind === "env")) issues.push({ severity: "warning", message: "缺少 env_snapshot，复现可能不完全" });
  return { ok: issues.filter((i) => i.severity === "critical").length === 0, issues };
}

export function bundleToManifest(bundle: EvidenceBundle): string {
  return JSON.stringify({ schemaVersion: 1, runKey: bundle.runKey, planFile: bundle.planFile, collectedAt: bundle.collectedAt, complete: bundle.complete, missing: bundle.missing, items: bundle.items.map((i) => ({ kind: i.kind, path: i.path, sha256: i.sha256, size: i.size })) }, null, 2);
}

export class EvidenceCollector {
  collect(runKey: string, files: Record<string, string>, planFile?: string): EvidenceBundle { return collectEvidence(runKey, files, planFile); }
  validate(bundle: EvidenceBundle): { ok: boolean; issues: Array<{ severity: "warning" | "critical"; message: string }> } { return validateBundle(bundle); }
  manifest(bundle: EvidenceBundle): string { return bundleToManifest(bundle); }
  async collectFromRemote(runKey: string, getRunEvidence: (params: unknown) => Promise<unknown>, params: Record<string, unknown> = {}): Promise<EvidenceBundle> {
    try {
      const data = await getRunEvidence({ ...params, runKey });
      const files: Record<string, string> = {};
      if (data && typeof data === "object") {
        const rec = data as Record<string, unknown>;
        if (Array.isArray(rec["files"])) for (const f of rec["files"] as Array<Record<string, unknown>>) files[String(f["path"] ?? f["name"] ?? "")] = String(f["content"] ?? "");
        else if (rec["evidence"]) Object.assign(files, rec["evidence"] as Record<string, string>);
        else Object.assign(files, rec as Record<string, string>);
      }
      return collectEvidence(runKey, files, params["planFile"] as string | undefined);
    } catch {
      return { runKey, planFile: params["planFile"] as string | undefined, items: [], complete: false, missing: ["remote_fetch_failed"], collectedAt: new Date().toISOString() };
    }
  }
}
