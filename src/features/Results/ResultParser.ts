/**
 * ResultParser — 从 Results.ts 提取解析器预设逻辑
 */

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type ResultsMod = {
  selectResultPreset?: (fileName: string, presets?: ResultParserPreset[]) => ResultParserPreset;
  previewResultParse?: (text: string, sourceFile: string, preset: ResultParserPreset, parserConfig: unknown) => unknown;
  parseResultFile?: (text: string, sourceFile: { path: string; type?: string; endpoint?: string }, preset: ResultParserPreset, parserConfig: unknown) => unknown[];
};

export interface ResultParserPreset { id: string; format: "long_csv" | "wide_csv" | "json" | "custom_csv"; filePatterns: string[]; columnMapping?: Record<string, string>; metricColumns?: string[]; requiredColumns?: string[]; }

function globMatch(filePath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i").test(String(filePath).replace(/\\/g, "/"));
}
function csvRows(text: string): string[][] {
  if (!text.trim()) return [];
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const out: string[] = []; let cur=""; let q=false;
    for (let i=0;i<line.length;i++){ const ch=line[i]; if(ch==='"'&&line[i+1]==='"'){cur+='"';i++;} else if(ch==='"') q=!q; else if(ch===','&&!q){out.push(cur.trim());cur="";} else cur+=ch;}
    out.push(cur.trim()); return out;
  });
}

export function selectPreset(fileName: string, presets?: ResultParserPreset[]): ResultParserPreset {
  const mod = tryRequire<ResultsMod>("../Results");
  if (mod?.selectResultPreset) return mod.selectResultPreset(fileName, presets);
  const builtIn: ResultParserPreset[] = (presets as ResultParserPreset[]) ?? [];
  if (builtIn.length) return builtIn.find((p) => p.filePatterns.some((pat) => globMatch(fileName, pat))) ?? builtIn[0];
  if (/\.json$/i.test(fileName)) return { id: "generic_json", format: "json", filePatterns: ["*.json"], columnMapping: {} };
  return { id: "generic_metric_wide_csv", format: "wide_csv", filePatterns: ["*.csv"], columnMapping: {}, metricColumns: [] };
}

export function previewParse(text: string, sourceFile: string, preset: ResultParserPreset, parserConfig: unknown = {}): unknown {
  const mod = tryRequire<ResultsMod>("../Results");
  if (mod?.previewResultParse) return mod.previewResultParse(text, sourceFile, preset, parserConfig);
  const rows = preset.format === "json" ? [] : csvRows(text);
  const headers = preset.format === "json" ? [] : (rows[0] ?? []);
  const missing = (preset.requiredColumns ?? []).filter((c) => !headers.includes(c));
  return { presetId: preset.id, format: preset.format, rows: Math.max(0, rows.length - 1), records: Math.max(0, rows.length - 1), columns: headers, missingRequiredColumns: missing, warnings: missing.length ? [`missing required columns: ${missing.join(", ")}`] : [], sampleMetrics: {} };
}

export function parseFile(text: string, sourceFile: { path: string; type?: string; endpoint?: string }, preset: ResultParserPreset, parserConfig: unknown = {}): unknown[] {
  const mod = tryRequire<ResultsMod>("../Results");
  if (mod?.parseResultFile) return mod.parseResultFile(text, sourceFile as unknown as { path: string; type?: string; endpoint?: string }, preset, parserConfig);
  if (preset.format === "json") {
    try { const data = JSON.parse(text) as unknown; return Array.isArray(data) ? data as unknown[] : [data]; } catch { return []; }
  }
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((cols, idx) => {
    const row: Record<string, string> = Object.fromEntries(headers.map((h,i)=>[h, cols[i]??""]));
    return { resultId: `${sourceFile.path}:${idx}`, experimentId: row["experiment_id"] ?? row["experimentId"] ?? `exp_${idx}`, runKey: row["run_key"] ?? row["runKey"] ?? "", suite: row["suite"] ?? "", metrics: Object.fromEntries(Object.entries(row).filter(([k])=> preset.metricColumns ? preset.metricColumns.includes(k) : !["experiment_id","suite","run_key"].includes(k)).map(([k,v])=>[k,{ value: Number(v) || v }])), dimensions: {}, sourceFiles: [sourceFile], status: "parsed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), provenance: {} };
  });
}

export class ResultParser {
  private readonly presetId: string;
  constructor(presetId = "generic_metric_wide_csv") { this.presetId = presetId; }
  select(fileName: string, presets?: ResultParserPreset[]): ResultParserPreset { return selectPreset(fileName, presets); }
  preview(text: string, sourceFile: string, preset?: ResultParserPreset, cfg: unknown = {}): unknown {
    const eff = preset ?? selectPreset(sourceFile);
    return previewParse(text, sourceFile, eff, cfg);
  }
  parse(text: string, sourceFile: { path: string; type?: string; endpoint?: string }, preset?: ResultParserPreset, cfg: unknown = {}): unknown[] {
    const eff = preset ?? selectPreset(sourceFile.path);
    return parseFile(text, sourceFile, eff, cfg);
  }
}
