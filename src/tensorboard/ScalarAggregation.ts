export interface SeedScalarSeries {
  seed: string;
  serverId: string;
  updatedAt: number;
  points: Array<[number, number]>;
}

export interface AggregatedScalarPoint {
  step: number;
  mean: number;
  std: number | null;
  n: number;
  seeds: Record<string, number>;
}

export function aggregateSeedScalars(rows: SeedScalarSeries[]): { points: AggregatedScalarPoint[]; seeds: SeedScalarSeries[] } {
  const chosen = new Map<string, SeedScalarSeries>();
  for (const row of rows) {
    if (!row.seed) continue;
    const previous = chosen.get(row.seed);
    if (!previous || row.updatedAt > previous.updatedAt || (row.updatedAt === previous.updatedAt && row.serverId < previous.serverId)) {
      chosen.set(row.seed, row);
    }
  }
  const byStep = new Map<number, Record<string, number>>();
  for (const row of chosen.values()) {
    const current = new Map<number, number>();
    for (const [step, value] of row.points) {
      if (Number.isFinite(step) && Number.isFinite(value)) current.set(step, value);
    }
    for (const [step, value] of current) {
      const values = byStep.get(step) || {};
      values[row.seed] = value;
      byStep.set(step, values);
    }
  }
  const points = [...byStep].sort(([a], [b]) => a - b).map(([step, seeds]) => {
    const values = Object.values(seeds);
    const n = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / n;
    const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : null;
    return { step, mean, std: variance === null ? null : Math.sqrt(variance), n, seeds };
  });
  return { points, seeds: [...chosen.values()].sort((a, b) => a.seed.localeCompare(b.seed, undefined, { numeric: true })) };
}
