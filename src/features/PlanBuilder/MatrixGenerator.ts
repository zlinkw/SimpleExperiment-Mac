/**
 * MatrixGenerator — 从 PlanBuilder.ts 提取矩阵生成逻辑
 * 支持 grid / paired / fixed / derived / conditional 五种模式
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
type PlanBuilderMod = {
  evaluateValueExpression?: (expr: string, row: Record<string, unknown>) => unknown;
  evaluateCondition?: (when: string, row: Record<string, unknown>) => boolean;
  evaluateConstraint?: (expr: string, row: Record<string, unknown>) => boolean;
  expandPlanMatrix?: (matrix: unknown, existingRunKeys: Iterable<string> | string[], suite: string) => unknown;
};

export interface MatrixVariable {
  key: string; mode: "grid" | "paired" | "fixed" | "derived" | "conditional"; values?: unknown[]; expression?: string; when?: string;
}
export interface PlanMatrix {
  variables: MatrixVariable[];
  constraints?: Array<{ id: string; expression: string; message: string }>;
  namingRule?: { pattern: string; sanitize?: boolean };
}

function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
function sanitizeName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/_+/g, "_").slice(0, 120);
}
function experimentName(suite: string, row: Record<string, unknown>): string {
  const parts = Object.entries(sortObject(row)).map(([k, v]) => `${k}_${v}`);
  return `${suite}__${parts.join("__") || "baseline"}`;
}
function renderNamingRule(pattern: string | undefined, suite: string, row: Record<string, unknown>): string {
  if (!pattern) return "";
  let out = pattern.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_: string, k: string) => String((row as Record<string, unknown>)[k] ?? suite ?? ""));
  out = out.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_: string, k: string) => String((row as Record<string, unknown>)[k] ?? suite ?? ""));
  return out;
}
function sha256(text: string): string {
  const c = tryRequire<CryptoMod>("crypto");
  if (c) return c.createHash("sha256").update(text).digest("hex");
  let h = 0; for (let i=0;i<text.length;i++) h=(h*31+text.charCodeAt(i))>>>0; return h.toString(16).padStart(16,"0");
}
function matrixPreviewCsv(experiments: Array<Record<string, unknown>>): string {
  const headers = ["experimentIndex","name","runKey","configOverrides"];
  const rows = experiments.map((e) => [e["experimentIndex"], e["name"], e["runKey"], JSON.stringify(e["configOverrides"])].map((v) => `"${String(v).replace(/"/g,'""')}"`).join(","));
  return [headers.join(","), ...rows].join("\n");
}
function varToLegacy(v: MatrixVariable): Record<string, unknown> { return { key: v.key, name: v.key, values: v.values, mode: v.mode, expression: v.expression, when: v.when }; }
function evaluateValueExpression(expr: string, row: Record<string, unknown>): unknown {
  if (!expr) return "";
  const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
  if (mod?.evaluateValueExpression) return mod.evaluateValueExpression(expr, row);
  try { const fn = new Function(...Object.keys(row), `return (${expr});`) as (...args: unknown[]) => unknown; return fn(...Object.values(row)); } catch { return expr; }
}
function evaluateCondition(when: string, row: Record<string, unknown>): boolean {
  const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
  if (mod?.evaluateCondition) return Boolean(mod.evaluateCondition(when, row));
  try { const fn = new Function(...Object.keys(row), `return Boolean(${when});`) as (...args: unknown[]) => unknown; return Boolean(fn(...Object.values(row))); } catch { return false; }
}
function evaluateConstraint(expr: string, row: Record<string, unknown>): boolean {
  const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
  if (mod?.evaluateConstraint) return Boolean(mod.evaluateConstraint(expr, row));
  if (!expr) return true;
  try { const fn = new Function(...Object.keys(row), `return Boolean(${expr});`) as (...args: unknown[]) => unknown; return Boolean(fn(...Object.values(row))); } catch { return false; }
}
function gridCombinations(variables: Array<Record<string, unknown>>): Record<string, unknown>[] {
  let rows: Record<string, unknown>[] = [{}];
  for (const variable of variables) {
    const next: Record<string, unknown>[] = [];
    for (const row of rows) for (const value of (variable["values"] as unknown[] ?? [])) next.push({ ...row, [String(variable["key"] ?? variable["name"])]: value });
    rows = next.length ? next : rows;
  }
  return rows;
}
function pairedCombinations(variables: Array<Record<string, unknown>>): Record<string, unknown>[] {
  if (!variables.length) return [{}];
  const len = Math.max(...variables.map((v) => ((v["values"] as unknown[]) ?? []).length));
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, unknown> = {};
    for (const v of variables) row[String(v["key"] ?? v["name"])] = ((v["values"] as unknown[]) ?? [])[i % (((v["values"] as unknown[]) ?? []).length)] as unknown;
    rows.push(row);
  }
  return rows;
}

export function generateMatrix(matrix: PlanMatrix, existingRunKeys: Iterable<string> | string[] = [], suite = "suite"): unknown {
  const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
  if (mod?.expandPlanMatrix) return mod.expandPlanMatrix(matrix, existingRunKeys, suite);
  const errors: string[] = [];
  const existingRunKeySet = existingRunKeys instanceof Set ? existingRunKeys as Set<string> : new Set(existingRunKeys as string[]);
  const generatedRunKeys = new Set<string>();
  const paired = matrix.variables.filter((item) => item.mode === "paired");
  const fixed = matrix.variables.filter((item) => item.mode === "fixed");
  const grid = matrix.variables.filter((item) => item.mode === "grid");
  const derived = matrix.variables.filter((item) => item.mode === "derived");
  const conditional = matrix.variables.filter((item) => item.mode === "conditional");
  const pairedRows = paired.length ? pairedCombinations(paired.map(varToLegacy)) : [{}];
  const gridRows = gridCombinations(grid.map(varToLegacy));
  const fixedRow = Object.fromEntries(fixed.map((item) => [item.key, item.values?.[0] ?? ""]));
  const experiments: Array<Record<string, unknown>> = [];
  const duplicateRunKeys: string[] = [];
  let filteredCount = 0;
  let index = 0;
  for (const pairedRow of pairedRows) {
    for (const gridRow of gridRows) {
      let row: Record<string, unknown> = { ...fixedRow, ...gridRow, ...pairedRow };
      for (const item of derived) row[item.key] = evaluateValueExpression(item.expression ?? "", row);
      for (const item of conditional) if (!item.when || evaluateCondition(item.when, row)) row[item.key] = item.expression ? evaluateValueExpression(item.expression, row) : item.values?.[0];
      let failed: { id: string } | undefined;
      try { failed = (matrix.constraints ?? []).find((c) => !evaluateConstraint(c.expression, row)) as { id: string } | undefined; } catch (e: unknown) { errors.push(e instanceof Error ? e.message : String(e)); failed = { id: "expression_error" }; }
      if (failed) { filteredCount++; continue; }
      const name = renderNamingRule(matrix.namingRule?.pattern, suite, row) || experimentName(suite, row);
      const safeName = matrix.namingRule?.sanitize === false ? name : sanitizeName(name);
      const runKey = `${suite}:${safeName}`;
      const experimentKey = sha256(`${suite}:${JSON.stringify(sortObject(row))}`).slice(0, 16);
      if (existingRunKeySet.has(runKey) || generatedRunKeys.has(runKey)) duplicateRunKeys.push(runKey);
      generatedRunKeys.add(runKey);
      experiments.push({ experimentIndex: index++, name: safeName, runKey, experimentKey, configOverrides: row, commandPreview: Object.entries(row).map(([k, v]) => `${k}=${String(v)}`).join(" ") });
    }
  }
  return { experiments, duplicateRunKeys: Array.from(new Set(duplicateRunKeys)), filteredCount, errors, yaml: "", previewCsv: matrixPreviewCsv(experiments) };
}

export class MatrixGenerator {
  generate(matrix: PlanMatrix, existingRunKeys: Iterable<string> | string[] = [], suite = "suite"): unknown { return generateMatrix(matrix, existingRunKeys, suite); }
  gridCombinations(variables: unknown[]): Record<string, unknown>[] { return gridCombinations(variables as Array<Record<string, unknown>>); }
  pairedCombinations(variables: unknown[]): Record<string, unknown>[] { return pairedCombinations(variables as Array<Record<string, unknown>>); }
}
