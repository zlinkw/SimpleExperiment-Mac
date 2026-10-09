/**
 * ResultsFactory — Results 工厂
 * 封装结果解析（parser preset / csv/json 解析 / leaderboard），委托给 features/Results
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
  selectResultPreset?: (fileName: string, presets?: unknown[]) => unknown;
  previewResultParse?: (text: string, sourceFile: string, preset: unknown, parserConfig: unknown) => unknown;
  previewTextMetricParse?: (text: string, sourceFile: string, opts: unknown) => unknown;
  parseResultFile?: (text: string, sourceFile: unknown, preset: unknown, parserConfig: unknown) => unknown[];
  validateResultRecords?: (records: unknown[], rules?: unknown[]) => unknown[];
  buildResultLeaderboard?: (records: unknown[], config: unknown, issues?: unknown[]) => unknown[];
};

type ResultParserMod = {
  selectPreset?: (fileName: string, presets?: unknown[]) => unknown;
  previewParse?: (text: string, sourceFile: string, preset: unknown, parserConfig: unknown) => unknown;
  parseFile?: (text: string, sourceFile: unknown, preset: unknown, parserConfig: unknown) => unknown[];
};

export interface ResultsFactoryOptions {
  defaultPresetId?: string;
  schemaId?: string;
}

export interface ResultsFactory {
  selectPreset(fileName: string, presets?: unknown[]): unknown;
  preview(text: string, sourceFile: string, preset?: unknown, parserConfig?: unknown): unknown;
  previewTextMetrics(text: string, sourceFile: string, opts?: unknown): unknown;
  parse(text: string, sourceFile: unknown, preset: unknown, parserConfig?: unknown): unknown[];
  validate(records: unknown[], rules?: unknown[]): unknown[];
  leaderboard(records: unknown[], config: unknown, issues?: unknown[]): unknown[];
  createParser(presetId?: string): { presetId: string; parse: (text: string, sourceFile: unknown, cfg?: unknown) => unknown[]; preview: (text: string, sourceFile: string, cfg?: unknown) => unknown };
}

class DefaultResultsFactory implements ResultsFactory {
  private readonly opts: ResultsFactoryOptions;
  constructor(opts: ResultsFactoryOptions = {}) { this.opts = opts; }

  selectPreset(fileName: string, presets?: unknown[]): unknown {
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.selectResultPreset) return mod.selectResultPreset(fileName, presets);
    const pm = tryRequire<ResultParserMod>("../Results/ResultParser");
    if (pm?.selectPreset) return pm.selectPreset(fileName, presets);
    throw new Error("结果解析 preset 实现不可用。");
  }

  preview(text: string, sourceFile: string, preset?: unknown, parserConfig: unknown = {}): unknown {
    const effPreset = (preset ?? this.selectPreset(sourceFile)) as Record<string, unknown>;
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.previewResultParse) return mod.previewResultParse(text, sourceFile, effPreset, parserConfig);
    const pm = tryRequire<ResultParserMod>("../Results/ResultParser");
    if (pm?.previewParse) return pm.previewParse(text, sourceFile, effPreset, parserConfig);
    throw new Error("结果解析预览实现不可用。");
  }

  previewTextMetrics(text: string, sourceFile: string, opts: unknown = {}): unknown {
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.previewTextMetricParse) return mod.previewTextMetricParse(text, sourceFile, opts);
    throw new Error("文本指标解析预览实现不可用。");
  }

  parse(text: string, sourceFile: unknown, preset: unknown, parserConfig: unknown = {}): unknown[] {
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.parseResultFile) return mod.parseResultFile(text, sourceFile, preset, parserConfig);
    const pm = tryRequire<ResultParserMod>("../Results/ResultParser");
    if (pm?.parseFile) return pm.parseFile(text, sourceFile, preset, parserConfig);
    throw new Error("结果文件解析实现不可用。");
  }

  validate(records: unknown[], rules?: unknown[]): unknown[] {
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.validateResultRecords) return mod.validateResultRecords(records, rules);
    throw new Error("结果记录校验实现不可用。");
  }

  leaderboard(records: unknown[], config: unknown, issues: unknown[] = []): unknown[] {
    const mod = tryRequire<ResultsMod>("../Results");
    if (mod?.buildResultLeaderboard) return mod.buildResultLeaderboard(records, config, issues);
    throw new Error("结果排行榜构建实现不可用。");
  }

  createParser(presetId?: string): { presetId: string; parse: (text: string, sourceFile: unknown, cfg?: unknown) => unknown[]; preview: (text: string, sourceFile: string, cfg?: unknown) => unknown } {
    const id = presetId ?? this.opts.defaultPresetId ?? "generic_metric_wide_csv";
    return {
      presetId: id,
      parse: (text: string, sourceFile: unknown, cfg?: unknown) => {
        const name = typeof sourceFile === "string" ? sourceFile : (sourceFile as Record<string, unknown>)?.["path"] as string ?? "results.csv";
        const preset = this.selectPreset(name) as Record<string, unknown>;
        const eff = preset["id"] === id ? preset : { ...preset, id };
        const src = typeof sourceFile === "string" ? { path: sourceFile, type: "csv", endpoint: "local" } : sourceFile;
        return this.parse(text, src, eff, cfg);
      },
      preview: (text: string, sourceFile: string, cfg?: unknown) => {
        const preset = this.selectPreset(sourceFile) as Record<string, unknown>;
        return this.preview(text, sourceFile, preset["id"] === id ? preset : { ...preset, id }, cfg);
      },
    };
  }
}

export function createResultsFactory(opts?: ResultsFactoryOptions): ResultsFactory {
  return new DefaultResultsFactory(opts);
}
export { DefaultResultsFactory };
