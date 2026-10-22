/**
 * src/features/GpuSampleRing.ts - Bounded host-side GPU sample ring (item 85 minimal channel).
 *
 * Stores only samples the Worker already measured and carried on the shared
 * execution-inventory responses. Every entry keeps the Worker's own seq, boot
 * epoch and collected time; the host never re-timestamps or interpolates.
 * Duplicated seq, out-of-order seq, wrong source and foreign workers are
 * rejected; an Agent restart (epoch switch) starts a fresh run instead of
 * splicing across generations. Window viewing is clipped locally from these
 * stored points, so switching windows sends no repeated history requests, and
 * coarse server-side buckets are never disguised as fine frames.
 */
export interface GpuRingSample {
    seq: number;
    epoch: string;
    collectedAt: number;
    workerId: string;
    source: string;
    gpus: unknown[];
}

export function gpuRingSampleFromCarried(workerId: string, carried: unknown): GpuRingSample | undefined {
    const item = carried && typeof carried === "object" ? carried as Record<string, unknown> : undefined;
    if (!item || item.source !== "worker_telemetry") return undefined;
    const seq = Number(item.seq);
    const epoch = String(item.epoch || "");
    const collectedAt = Date.parse(String(item.generatedAt || ""));
    if (!Number.isSafeInteger(seq) || seq <= 0 || !epoch || !Number.isFinite(collectedAt)) return undefined;
    const gpus = Array.isArray(item.gpus) ? item.gpus : Array.isArray(item.gpu) ? item.gpu : undefined;
    if (!gpus) return undefined;
    return { seq, epoch, collectedAt, workerId: String(workerId || ""), source: "worker_telemetry", gpus };
}

export class GpuSampleRing {
    private readonly runs = new Map<string, { epoch: string; source: unknown; lastSeq: number; retired: string[]; samples: GpuRingSample[] }>();
    constructor(private readonly capacity = 900) { }
    push(workerId: string, carried: unknown, origin: { source?: unknown } = {}): boolean {
        const sample = gpuRingSampleFromCarried(workerId, carried);
        if (!sample || !sample.workerId) return false;
        let run = this.runs.get(sample.workerId);
        if (!run) { run = { epoch: sample.epoch, source: origin.source, lastSeq: 0, retired: [], samples: [] }; this.runs.set(sample.workerId, run); }
        if (run.epoch !== sample.epoch) {
            // Generations are accepted or refused by request attribution, never by
            // comparing timestamps or ordering epoch strings: the monotonic clock and
            // wall clock both move in real deployments. The Host verified the frame
            // belongs to the still-current request/root/client BEFORE pushing here,
            // so a different epoch reaching the ring is the current generation's own
            // restart and is accepted even when the wall clock rolled backwards.
            // Every epoch a run has left behind is retired for this Worker: a late
            // frame of a retired epoch is refused no matter how high its seq or how
            // late its collected time, so it can never clear the newer history.
            if (run.retired.includes(sample.epoch)) return false;
            run.retired.push(run.epoch);
            if (run.retired.length > GpuSampleRing.retiredEpochLimit) run.retired.splice(0, run.retired.length - GpuSampleRing.retiredEpochLimit);
            run.epoch = sample.epoch; run.source = origin.source; run.lastSeq = 0; run.samples = [];
        }
        else if (origin.source !== undefined) {
            // A reconnect on the same live Agent keeps one epoch; attribution follows
            // the current request and the Worker's own seq continues the run.
            run.source = origin.source;
        }
        // Within one generation the Worker's own seq is the dedup and ordering authority.
        if (sample.seq <= run.lastSeq) return false;
        run.lastSeq = sample.seq;
        run.samples.push(sample);
        if (run.samples.length > this.capacity) run.samples.splice(0, run.samples.length - this.capacity);
        return true;
    }
    // Bounded: at most this many retired epochs are remembered per Worker.
    private static readonly retiredEpochLimit = 8;
    // Local window clipping only: returned frames are stored Worker measurements
    // inside [start, end]; nothing between them is synthesized.
    slice(workerId: string, window: { start: number; end: number; maxPoints?: number } = { start: 0, end: Number.MAX_SAFE_INTEGER }): GpuRingSample[] {
        const run = this.runs.get(String(workerId || ""));
        if (!run) return [];
        const inWindow = run.samples.filter(sample => sample.collectedAt >= window.start && sample.collectedAt <= window.end);
        const maxPoints = Number.isSafeInteger(window.maxPoints) && Number(window.maxPoints) > 0 ? Number(window.maxPoints) : inWindow.length;
        if (inWindow.length <= maxPoints) return inWindow.slice();
        const stride = inWindow.length / maxPoints;
        const thinned: GpuRingSample[] = [];
        for (let index = 0; index < maxPoints; index++) thinned.push(inWindow[Math.floor(index * stride)]);
        if (thinned[thinned.length - 1] !== inWindow[inWindow.length - 1]) thinned[thinned.length - 1] = inWindow[inWindow.length - 1];
        return thinned;
    }
    size(workerId: string): number { return this.runs.get(String(workerId || ""))?.samples.length || 0; }
    latest(workerId: string): GpuRingSample | undefined {
        const run = this.runs.get(String(workerId || ""));
        return run && run.samples.length ? run.samples[run.samples.length - 1] : undefined;
    }
}
