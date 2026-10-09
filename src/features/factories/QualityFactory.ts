/**
 * QualityFactory — Quality 工厂
 * 封装 OutputContract / QualityGate / 统计分析，委托给 features/Quality
 */

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type QualityMod = {
  checkProjectOutputContract?: (files: Record<string, string>, contract: unknown, context: unknown) => unknown;
  runQualityGate?: (record: unknown, gate: unknown, report: unknown, cases: unknown[]) => unknown;
  runDataLeakageCheck?: (rows: unknown[], expectedCounts?: Record<string, number>) => unknown;
  runStatisticalAnalysis?: (plan: unknown, rows: unknown[], methods: string[], comparisonId?: string) => unknown[];
  filterRecordsByQualityGate?: (records: unknown[], results: unknown[], policy?: unknown) => unknown[];
  builtInOutputContracts?: Array<{ id: string; qualityGates?: Array<{ id: string }> } & Record<string, unknown>>;
};

export interface QualityFactoryOptions {
  defaultContractId?: string;
  defaultGateId?: string;
}

export interface QualityFactory {
  checkContract(files: Record<string, string>, contract?: unknown, context?: unknown): unknown;
  runQualityGate(record: unknown, gate: unknown, contractReport?: unknown, caseRecords?: unknown[]): unknown;
  runLeakageCheck(rows: unknown[], expectedCounts?: Record<string, number>): unknown;
  runStatisticalAnalysis(plan: unknown, rows: unknown[], methods: string[], comparisonId?: string): unknown[];
  createGateRunner(gateId?: string): { check: (record: unknown, gate?: unknown, report?: unknown, cases?: unknown[]) => unknown; filter: (records: unknown[], results: unknown[], policy?: unknown) => unknown[] };
}

class DefaultQualityFactory implements QualityFactory {
  private readonly opts: QualityFactoryOptions;
  constructor(opts: QualityFactoryOptions = {}) { this.opts = opts; }

  checkContract(files: Record<string, string>, contract?: unknown, context: unknown = {}): unknown {
    const effContract = contract ?? this.resolveDefaultContract();
    const mod = tryRequire<QualityMod>("../Quality");
    if (mod?.checkProjectOutputContract) return mod.checkProjectOutputContract(files, effContract, context);
    throw new Error("项目输出契约检查实现不可用。");
  }

  runQualityGate(record: unknown, gate: unknown, contractReport?: unknown, caseRecords: unknown[] = []): unknown {
    const effGate = gate ?? this.resolveDefaultGate();
    const mod = tryRequire<QualityMod>("../Quality");
    if (mod?.runQualityGate) return mod.runQualityGate(record, effGate, contractReport, caseRecords);
    throw new Error("质量门禁实现不可用，拒绝把未执行检查标记为通过。");
  }

  runLeakageCheck(rows: unknown[], expectedCounts?: Record<string, number>): unknown {
    const mod = tryRequire<QualityMod>("../Quality");
    if (mod?.runDataLeakageCheck) return mod.runDataLeakageCheck(rows, expectedCounts);
    throw new Error("数据泄漏检查实现不可用。");
  }

  runStatisticalAnalysis(plan: unknown, rows: unknown[], methods: string[], comparisonId = "comparison"): unknown[] {
    const mod = tryRequire<QualityMod>("../Quality");
    if (mod?.runStatisticalAnalysis) return mod.runStatisticalAnalysis(plan, rows, methods, comparisonId);
    throw new Error("统计分析实现不可用。");
  }

  createGateRunner(gateId?: string): { check: (record: unknown, gate?: unknown, report?: unknown, cases?: unknown[]) => unknown; filter: (records: unknown[], results: unknown[], policy?: unknown) => unknown[] } {
    return {
      check: (record: unknown, gate?: unknown, report?: unknown, cases?: unknown[]) => this.runQualityGate(record, gate ?? this.resolveDefaultGate(), report, cases),
      filter: (records: unknown[], results: unknown[], policy?: unknown) => {
        const mod = tryRequire<QualityMod>("../Quality");
        if (mod?.filterRecordsByQualityGate) return mod.filterRecordsByQualityGate(records, results, policy) as unknown[];
        return (records as unknown[]).filter((r) => !results.some((gr: unknown) => (gr as Record<string, unknown>)["experimentId"] === (r as Record<string, unknown>)["experimentId"] && (gr as Record<string, unknown>)["status"] === "failed"));
      },
    };
  }

  private resolveDefaultContract(): unknown {
    const mod = tryRequire<QualityMod>("../Quality");
    if (mod?.builtInOutputContracts?.length) {
      const found = mod.builtInOutputContracts.find((c) => c.id === this.opts.defaultContractId);
      return found ?? mod.builtInOutputContracts[0];
    }
    throw new Error("默认项目输出契约不可用，请显式选择有效契约。");
  }
  private resolveDefaultGate(): unknown {
    const mod = tryRequire<QualityMod>("../Quality");
    const contract = this.resolveDefaultContract() as Record<string, unknown>;
    const gates = contract["qualityGates"] as Array<{ id: string }> | undefined;
    if (Array.isArray(gates) && gates.length) {
      const found = gates.find((g) => g.id === this.opts.defaultGateId);
      return found ?? gates[0];
    }
    throw new Error(`默认质量门禁不可用${contract["id"] ? `（契约 ${String(contract["id"])}）` : ""}，请显式选择有效门禁。`);
  }
}

export function createQualityFactory(opts?: QualityFactoryOptions): QualityFactory {
  return new DefaultQualityFactory(opts);
}
export { DefaultQualityFactory };
