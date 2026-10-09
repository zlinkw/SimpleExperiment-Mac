/**
 * PlanBuilderFactory — PlanBuilder 工厂
 * 封装 ExperimentMatrix 生成逻辑，委托给 features/PlanBuilder
 */

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type PlanBuilderMod = {
  buildExperimentMatrix?: (matrix: unknown, existingRunKeys: string[]) => unknown;
  expandPlanMatrix?: (matrix: unknown, existingRunKeys: string[]) => unknown;
  renderPlanYaml?: (matrix: unknown, experiments: unknown[]) => string;
  parsePlanCases?: (yaml: string) => string[];
  validateDeepLearningPlanContract?: (yaml: string) => unknown;
};

type MatrixGeneratorMod = {
  generateMatrix?: (matrix: unknown, existingRunKeys: string[]) => unknown;
  MatrixGenerator?: new () => { generate(matrix: unknown, existingRunKeys: string[]): unknown };
};

type PlanValidatorMod = {
  validatePlan?: (yaml: string) => unknown;
};

export interface PlanBuilderFactoryOptions {
  defaultSuite?: string;
  defaultBaseConfig?: string;
  defaultNamingPattern?: string;
}

export interface PlanBuilderFactory {
  buildMatrix(matrix: unknown, existingRunKeys?: string[]): unknown;
  renderYaml(matrix: unknown, experiments: unknown[]): string;
  parseCases(yaml: string): string[];
  validate(yaml: string): unknown;
  create(matrix: unknown): { matrix: unknown; build: (existingRunKeys?: string[]) => unknown };
}

class DefaultPlanBuilderFactory implements PlanBuilderFactory {
  private readonly opts: PlanBuilderFactoryOptions;
  constructor(opts: PlanBuilderFactoryOptions = {}) { this.opts = opts; }

  buildMatrix(matrix: unknown, existingRunKeys: string[] = []): unknown {
    const normalized = this.normalizeMatrix(matrix as Record<string, unknown>);
    const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
    if (mod?.buildExperimentMatrix) return mod.buildExperimentMatrix(normalized, existingRunKeys);
    if (mod?.expandPlanMatrix) return mod.expandPlanMatrix(normalized, existingRunKeys);
    const mg = tryRequire<MatrixGeneratorMod>("../PlanBuilder/MatrixGenerator");
    if (mg?.generateMatrix) return mg.generateMatrix(normalized, existingRunKeys);
    if (mg?.MatrixGenerator) {
      const gen = new mg.MatrixGenerator();
      return gen.generate(normalized, existingRunKeys);
    }
    throw new Error("PlanBuilder 矩阵实现不可用，拒绝返回空构建结果。");
  }

  renderYaml(matrix: unknown, experiments: unknown[]): string {
    const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
    if (mod?.renderPlanYaml) return mod.renderPlanYaml(matrix, experiments);
    throw new Error("PlanBuilder YAML 渲染实现不可用。");
  }

  parseCases(yaml: string): string[] {
    const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
    if (mod?.parsePlanCases) return mod.parsePlanCases(yaml);
    throw new Error("PlanBuilder case 解析实现不可用。");
  }

  validate(yaml: string): unknown {
    const mod = tryRequire<PlanBuilderMod>("../PlanBuilder");
    if (mod?.validateDeepLearningPlanContract) return mod.validateDeepLearningPlanContract(yaml);
    const vmod = tryRequire<PlanValidatorMod>("../PlanBuilder/PlanValidator");
    if (vmod?.validatePlan) return vmod.validatePlan(yaml);
    throw new Error("Plan 校验实现不可用，拒绝把未校验 Plan 标记为通过。");
  }

  create(matrix: unknown): { matrix: unknown; build: (existingRunKeys?: string[]) => unknown } {
    const normalized = this.normalizeMatrix(matrix as Record<string, unknown>);
    return { matrix: normalized, build: (existingRunKeys?: string[]) => this.buildMatrix(normalized, existingRunKeys) };
  }

  private normalizeMatrix(matrix: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!matrix) return { baseConfig: this.opts.defaultBaseConfig ?? "", suite: this.opts.defaultSuite ?? "suite", variables: [], seeds: [], constraints: [] };
    return {
      baseConfig: (matrix["baseConfig"] as string) ?? this.opts.defaultBaseConfig ?? "",
      suite: (matrix["suite"] as string) ?? this.opts.defaultSuite ?? "suite",
      variables: Array.isArray(matrix["variables"]) ? matrix["variables"] : [],
      seeds: Array.isArray(matrix["seeds"]) ? matrix["seeds"] : [],
      constraints: Array.isArray(matrix["constraints"]) ? matrix["constraints"] : [],
      namingRule: (matrix["namingRule"] as unknown) ?? (this.opts.defaultNamingPattern ? { pattern: this.opts.defaultNamingPattern } : undefined),
    };
  }
}

export function createPlanBuilderFactory(opts?: PlanBuilderFactoryOptions): PlanBuilderFactory {
  return new DefaultPlanBuilderFactory(opts);
}
export { DefaultPlanBuilderFactory };
