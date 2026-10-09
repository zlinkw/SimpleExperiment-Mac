import * as path from "path";
import { optionalApi } from "../api";
import { DEFAULT_PLAN_DIR, PLAN_REGISTRY_REL, fileExists, listFilesRecursive, projectRoot, readJsonFile, readTextFile, resolveProjectPath } from "../data";
import { businessError, usageError } from "../errors";
import { block, table, writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { expandPlanMatrix, importLegacyPlanYamlToRegistry, parsePlanSummary, validateDeepLearningPlanContract } from "../../features/PlanBuilder";
import { validatePlan } from "../../features/PlanBuilder/PlanValidator";

export async function planCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "list") return planList(flags);
  if (action === "validate") return planValidate(requirePositional(rest, 0, "plan file"), flags);
  if (action === "matrix") return planMatrix(requirePositional(rest, 0, "plan file"), flags);
  throw usageError(`unknown plan action: ${action || "(missing)"}`);
}

export async function planList(flags: CliFlags): Promise<number> {
  const rows = await loadPlans();
  if (flags.json) {
    writeJson(rows, flags.compactJson);
    return 0;
  }
  writeText(table(["name", "path", "status", "validation"], rows));
  return 0;
}

export async function planValidate(fileArg: string, flags: CliFlags): Promise<number> {
  const file = resolveExisting(fileArg);
  const yaml = readTextFile(file);
  const contract = validateDeepLearningPlanContract(yaml);
  const validator = validatePlan(yaml);
  const errors = [
    ...(contract.issues || []).map((issue: { message?: string; field?: string; label?: string }) => String(issue.message || issue.field || issue.label || "")),
    ...(validator.errors || []).map((issue) => issue.message),
  ].filter(Boolean);
  const valid = Boolean(contract.ok) && validator.status !== "failed";
  const payload = valid ? { valid: true } : { valid: false, errors };
  writeJson(payload, flags.compactJson);
  return valid ? 0 : 3;
}

export async function planMatrix(fileArg: string, flags: CliFlags): Promise<number> {
  const file = resolveExisting(fileArg);
  const yaml = readTextFile(file);
  const summary = parsePlanSummary(yaml);
  const result = expandPlanMatrix({
    variables: [
      ...(summary.cases.length ? [{ key: "case", mode: "grid" as const, values: summary.cases }] : []),
      ...(summary.seeds.length ? [{ key: "seed", mode: "grid" as const, values: summary.seeds }] : []),
    ],
    namingRule: { pattern: "{suite}_{case}", sanitize: true },
  }, [], summary.suite || "suite");
  const count = Array.isArray(result.experiments) ? result.experiments.length : 0;
  const payload = { count, suite: summary.suite, cases: summary.cases.length, seeds: summary.seeds.length, filteredCount: result.filteredCount || 0 };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(block("Plan matrix", payload));
  return 0;
}

async function loadPlans(): Promise<Array<{ name: string; path: string; status: string; validation: string }>> {
  const rows: Array<{ name: string; path: string; status: string; validation: string }> = [];
  const remote = await optionalApi("plans.list");
  const remotePlans = Array.isArray((remote as { plans?: unknown })?.plans) ? (remote as { plans: unknown[] }).plans : [];
  for (const item of remotePlans) {
    const record = asRecord(item);
    const file = String(record.planFile || record.file || record.path || "");
    rows.push({
      name: String(record.planName || record.name || record.suite || path.basename(file)),
      path: file,
      status: String(record.status || "unknown"),
      validation: String(record.validation || record.valid || ""),
    });
  }
  const registry = readJsonFile<unknown>(resolveProjectPath(PLAN_REGISTRY_REL), []);
  const registryRows = Array.isArray(registry) ? registry : asRecord(registry).plans;
  if (Array.isArray(registryRows)) {
    for (const item of registryRows) {
      const record = asRecord(item);
      const file = String(record.planFile || record.path || "");
      if (rows.some((row) => row.path === file)) continue;
      rows.push({
        name: String(record.planName || record.name || path.basename(file)),
        path: file,
        status: String(record.status || "draft"),
        validation: "",
      });
    }
  }
  const files = listFilesRecursive(resolveProjectPath(DEFAULT_PLAN_DIR), (name) => /\.ya?ml$/i.test(name));
  for (const file of files) {
    const rel = path.relative(projectRoot(), file).replace(/\\/g, "/");
    if (rows.some((row) => row.path === rel || row.path === file)) continue;
    const yaml = readTextFile(file);
    const contract = validateDeepLearningPlanContract(yaml);
    const imported = importLegacyPlanYamlToRegistry(rel, yaml, []);
    rows.push({
      name: imported.planName || imported.suite,
      path: rel,
      status: imported.status,
      validation: contract.ok ? "ok" : "failed",
    });
  }
  return rows;
}

function resolveExisting(fileArg: string): string {
  const abs = path.isAbsolute(fileArg) ? fileArg : resolveProjectPath(fileArg);
  if (!fileExists(abs)) throw businessError(`plan file not found: ${fileArg}`);
  return abs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
