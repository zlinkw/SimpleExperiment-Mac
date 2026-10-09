import * as fs from "fs/promises";
import * as path from "path";

export interface OfflineBundle {
  schemaVersion: number;
  importedFrom?: string;
  lastImportedAt?: string;
  snapshot?: unknown;
  results?: unknown;
  diagnostics?: unknown;
  auditTail?: unknown;
  qualityGate?: unknown;
  paperTable?: unknown;
}

export interface OfflineImportResult {
  ok: boolean;
  bundle?: OfflineBundle;
  error?: string;
}

export async function importOfflineBundle(sourcePath: string): Promise<OfflineImportResult> {
  try {
    const stat = await fs.stat(sourcePath);
    const bundle = stat.isDirectory()
      ? await importOfflineDirectory(sourcePath)
      : JSON.parse(await fs.readFile(sourcePath, "utf8")) as OfflineBundle;
    if (!Number.isInteger(bundle.schemaVersion)) return { ok: false, error: "offline bundle missing schemaVersion" };
    return {
      ok: true,
      bundle: {
        ...bundle,
        importedFrom: sourcePath,
        lastImportedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function importOfflineDirectory(dir: string): Promise<OfflineBundle> {
  const snapshot = await readOptionalJson(path.join(dir, "cluster_snapshot.json"));
  const diagnostics = await readOptionalJson(path.join(dir, "diagnostics.json"));
  const auditTail = await readOptionalText(path.join(dir, "audit_tail.jsonl"));
  const results = await readOptionalJson(path.join(dir, "results_summary.json"));
  const qualityGate = await readOptionalJson(path.join(dir, "quality_gate.json"));
  const paperTable = await readOptionalJson(path.join(dir, "paper_table.json"));
  return {
    schemaVersion: Number((snapshot as { schemaVersion?: number } | undefined)?.schemaVersion || 1),
    snapshot,
    diagnostics,
    auditTail,
    results,
    qualityGate,
    paperTable,
  };
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
