export type TunnelRequestPurpose =
  | "health"
  | "snapshot"
  | "gpu_history"
  | "live_output"
  | "manual_refresh"
  | "run_plan"
  | "job_dispatch"
  | "job_reconcile"
  | "stop"
  | "parse_results"
  | "diagnostics"
  | "events"
  | "file_transfer"
  | "tensorboard_scalar";

export type RequestBudgetBlockReason =
  | "paused"
  | "rate_limited"
  | "hidden"
  | "cooldown"
  | "offline"
  | "queue_full";

export interface RequestBudgetConfig {
  // Legacy settings are accepted for stored-config compatibility, but no longer gate requests.
  maxRequestsPerMinute: number;
  /** Legacy aggregate value; retained for settings compatibility. */
  maxConcurrentRequests: number;
  maxConcurrentRequestsPerWorker?: number;
  maxConcurrentRequestsGlobal?: number;
  maxConcurrentTransfersPerWorker?: number;
  maxConcurrentTransfersGlobal?: number;
  maxConcurrentEmergencyRequests?: number;
  maxQueuedRequests?: number;
  minIntervalByPurpose: Partial<Record<TunnelRequestPurpose, number>>;
  pauseWhenHidden: boolean;
  allowManualOverride: boolean;
  disabledPurposes?: TunnelRequestPurpose[];
}

export interface RequestBudgetDecision {
  allowed: boolean;
  reason?: RequestBudgetBlockReason;
  retryAfterMs?: number;
}

export interface RequestBudgetRunOptions {
  userInitiated?: boolean;
  visibleBypass?: boolean;
  signal?: AbortSignal;
}

export interface RequestBudgetSnapshot {
  paused: boolean;
  hidden: boolean;
  inFlight: number;
  queued: number;
  globalInFlight: number;
  transferInFlight: number;
  emergencyInFlight: number;
  maxConcurrentRequestsPerWorker: number;
  maxConcurrentRequestsGlobal: number;
  maxConcurrentTransfersPerWorker: number;
  maxConcurrentTransfersGlobal: number;
  maxConcurrentEmergencyRequests: number;
  maxQueuedRequests: number;
  queueWaitMsLast: number;
  maxQueueDepth: number;
  coalescedRequests: number;
  retries: number;
  maxRequestsPerMinute: number;
  requestsLastMinute: number;
  deniedLastMinute: number;
  lastAllowedAt?: string;
  lastDeniedReason?: RequestBudgetBlockReason;
}

type BudgetEvent = {
  at: number;
  purpose: TunnelRequestPurpose;
  allowed: boolean;
  reason?: RequestBudgetBlockReason;
};

type BudgetEventBucket = { second: number; allowed: number; denied: number };

export const defaultRequestBudgetConfig: RequestBudgetConfig = {
  maxRequestsPerMinute: 0,
  maxConcurrentRequests: 0,
  maxConcurrentRequestsPerWorker: 4,
  maxConcurrentRequestsGlobal: 8,
  maxConcurrentTransfersPerWorker: 1,
  maxConcurrentTransfersGlobal: 2,
  maxConcurrentEmergencyRequests: 2,
  maxQueuedRequests: 256,
  pauseWhenHidden: true,
  allowManualOverride: true,
  disabledPurposes: [],
  minIntervalByPurpose: {},
};

type RequestPool = "control" | "transfer" | "emergency";

interface RequestBudgetLimits {
  maxConcurrentRequestsPerWorker: number;
  maxConcurrentRequestsGlobal: number;
  maxConcurrentTransfersPerWorker: number;
  maxConcurrentTransfersGlobal: number;
  maxConcurrentEmergencyRequests: number;
  maxQueuedRequests: number;
}

interface QueueRequest {
  pool: RequestPool;
  scopeKey: string;
  purpose: TunnelRequestPurpose;
  signal?: AbortSignal;
  queuedAt: number;
  isAllowed: () => RequestBudgetDecision;
  onStart: (waitMs: number) => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abortListener?: () => void;
  settled: boolean;
}

function positiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function abortError(): Error {
  const error = new Error("Request cancelled before it started.");
  error.name = "AbortError";
  return error;
}

/** Shared scheduler for all endpoint budgets belonging to one realtime client. */
export class RequestBudgetCoordinator {
  private readonly queues: Record<RequestPool, QueueRequest[]> = { emergency: [], control: [], transfer: [] };
  private readonly activeByPool: Record<RequestPool, number> = { emergency: 0, control: 0, transfer: 0 };
  private readonly activeByScope: Record<RequestPool, Map<string, number>> = {
    emergency: new Map(), control: new Map(), transfer: new Map(),
  };
  private dispatching = false;
  private dispatchAgain = false;
  private observedMaxQueueDepth = 0;
  private nextRegularPool: "control" | "transfer" = "control";

  readonly limits: RequestBudgetLimits;

  constructor(config: Partial<RequestBudgetLimits> = defaultRequestBudgetConfig) {
    this.limits = {
      maxConcurrentRequestsPerWorker: positiveLimit(config.maxConcurrentRequestsPerWorker, 4),
      maxConcurrentRequestsGlobal: positiveLimit(config.maxConcurrentRequestsGlobal, 8),
      maxConcurrentTransfersPerWorker: positiveLimit(config.maxConcurrentTransfersPerWorker, 1),
      maxConcurrentTransfersGlobal: positiveLimit(config.maxConcurrentTransfersGlobal, 2),
      maxConcurrentEmergencyRequests: positiveLimit(config.maxConcurrentEmergencyRequests, 2),
      maxQueuedRequests: positiveLimit(config.maxQueuedRequests, 256),
    };
  }

  get queued(): number { return this.queues.emergency.length + this.queues.control.length + this.queues.transfer.length; }
  get maxQueueDepth(): number { return this.observedMaxQueueDepth; }
  get globalInFlight(): number { return this.activeByPool.control; }
  get transferInFlight(): number { return this.activeByPool.transfer; }
  get emergencyInFlight(): number { return this.activeByPool.emergency; }

  acquire(
    pool: RequestPool,
    scopeKey: string,
    purpose: TunnelRequestPurpose,
    signal: AbortSignal | undefined,
    isAllowed: () => RequestBudgetDecision,
    onStart: (waitMs: number) => void,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    const initialDecision = isAllowed();
    if (!initialDecision.allowed) return Promise.reject(new RequestBudgetDeniedError(purpose, initialDecision));
    if (this.queued >= this.limits.maxQueuedRequests) {
      return Promise.reject(new RequestBudgetDeniedError(purpose, { allowed: false, reason: "queue_full" }));
    }

    return new Promise((resolve, reject) => {
      const item: QueueRequest = {
        pool, scopeKey, purpose, signal, queuedAt: Date.now(), isAllowed, onStart, resolve, reject, settled: false,
      };
      if (signal) {
        item.abortListener = () => {
          if (item.settled) return;
          const queue = this.queues[item.pool];
          const index = queue.indexOf(item);
          if (index < 0) return;
          queue.splice(index, 1);
          this.reject(item, abortError());
          this.drain();
        };
        signal.addEventListener("abort", item.abortListener, { once: true });
      }
      this.queues[pool].push(item);
      this.observedMaxQueueDepth = Math.max(this.observedMaxQueueDepth, this.queued);
      queueMicrotask(() => this.drain());
    });
  }

  notifyStateChanged(): void { this.drain(); }

  private drain(): void {
    if (this.dispatching) { this.dispatchAgain = true; return; }
    this.dispatching = true;
    try {
      do {
        this.dispatchAgain = false;
        for (const pool of ["emergency", "control", "transfer"] as const) {
          const queue = this.queues[pool];
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            const item = queue[index];
            if (!item) continue;
            if (item.signal?.aborted) {
              queue.splice(index, 1);
              this.reject(item, abortError());
              this.dispatchAgain = true;
            } else {
              const decision = item.isAllowed();
              if (!decision.allowed) {
                queue.splice(index, 1);
                this.reject(item, new RequestBudgetDeniedError(item.purpose, decision));
                this.dispatchAgain = true;
              }
            }
          }
        }
        let progressed = true;
        while (progressed) {
          progressed = false;
          // Emergency work gets first refusal because stop/recovery must stay
          // responsive under transfer load. Ordinary control and bulk-transfer
          // queues alternate so a steady stream of snapshots cannot starve sync,
          // and a long sync cannot starve snapshots indefinitely.
          const regularOrder: readonly ("control" | "transfer")[] = this.nextRegularPool === "control"
            ? ["control", "transfer"]
            : ["transfer", "control"];
          for (const pool of ["emergency", ...regularOrder] as const) {
            const index = this.queues[pool].findIndex((item) => this.canStart(item));
            if (index < 0) continue;
            const [item] = this.queues[pool].splice(index, 1);
            if (!item) continue;
            const decision = item.isAllowed();
            if (!decision.allowed) {
              this.reject(item, new RequestBudgetDeniedError(item.purpose, decision));
              progressed = true;
              break;
            }
            this.activate(item);
            if (pool === "control") this.nextRegularPool = "transfer";
            else if (pool === "transfer") this.nextRegularPool = "control";
            progressed = true;
            break;
          }
        }
      } while (this.dispatchAgain);
    } finally {
      this.dispatching = false;
    }
  }

  private canStart(item: QueueRequest): boolean {
    const { pool, scopeKey } = item;
    const activeGlobal = this.activeByPool[pool];
    const activeScope = this.activeByScope[pool].get(scopeKey) || 0;
    if (pool === "emergency") return activeGlobal < this.limits.maxConcurrentEmergencyRequests && activeScope < this.limits.maxConcurrentEmergencyRequests;
    if (pool === "transfer") return activeGlobal < this.limits.maxConcurrentTransfersGlobal && activeScope < this.limits.maxConcurrentTransfersPerWorker;
    return activeGlobal < this.limits.maxConcurrentRequestsGlobal && activeScope < this.limits.maxConcurrentRequestsPerWorker;
  }

  private activate(item: QueueRequest): void {
    if (item.signal?.aborted) { this.reject(item, abortError()); return; }
    this.adjustActive(item.pool, item.scopeKey, 1);
    item.settled = true;
    if (item.abortListener) item.signal?.removeEventListener("abort", item.abortListener);
    try { item.onStart(Math.max(0, Date.now() - item.queuedAt)); }
    catch (error) {
      this.adjustActive(item.pool, item.scopeKey, -1);
      item.reject(error);
      this.dispatchAgain = true;
      return;
    }
    let released = false;
    item.resolve(() => {
      if (released) return;
      released = true;
      this.adjustActive(item.pool, item.scopeKey, -1);
      this.drain();
    });
  }

  private adjustActive(pool: RequestPool, scopeKey: string, delta: number): void {
    this.activeByPool[pool] = Math.max(0, this.activeByPool[pool] + delta);
    const next = Math.max(0, (this.activeByScope[pool].get(scopeKey) || 0) + delta);
    if (next) this.activeByScope[pool].set(scopeKey, next);
    else this.activeByScope[pool].delete(scopeKey);
  }

  private reject(item: QueueRequest, error: unknown): void {
    if (item.settled) return;
    item.settled = true;
    if (item.abortListener) item.signal?.removeEventListener("abort", item.abortListener);
    item.reject(error);
  }
}

export class RequestBudgetDeniedError extends Error {
  constructor(
    public readonly purpose: TunnelRequestPurpose,
    public readonly decision: RequestBudgetDecision,
  ) {
    super(`Request blocked: ${decision.reason || "unknown"}`);
  }
}

export class RequestBudget {
  private inFlight = 0;
  private queued = 0;
  private queueWaitMsLast = 0;
  private coalescedRequests = 0;
  private retries = 0;
  private scopeKey = "default";
  private coordinator: RequestBudgetCoordinator;
  private paused = false;
  private hidden = false;
  private readonly events: BudgetEvent[] = [];
  private eventStart = 0;
  private readonly eventBuckets: BudgetEventBucket[] = [];
  private eventBucketStart = 0;
  private allowedEventCount = 0;
  private deniedEventCount = 0;
  private lastAllowedAt?: number;
  private lastDeniedReason?: RequestBudgetBlockReason;

  constructor(private readonly config: RequestBudgetConfig = defaultRequestBudgetConfig, coordinator?: RequestBudgetCoordinator) {
    this.coordinator = coordinator || new RequestBudgetCoordinator(config);
  }

  attachCoordinator(coordinator: RequestBudgetCoordinator, scopeKey: string): void {
    this.coordinator = coordinator;
    this.scopeKey = String(scopeKey || "default");
    this.coordinator.notifyStateChanged();
  }

  createCoordinator(): RequestBudgetCoordinator {
    return new RequestBudgetCoordinator(this.config);
  }

  noteCoalescedRequest(): void { this.coalescedRequests += 1; }
  noteRetry(): void { this.retries += 1; }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.coordinator.notifyStateChanged();
  }

  pauseAll(): void {
    this.paused = true;
    this.coordinator.notifyStateChanged();
  }

  resume(): void {
    this.paused = false;
    this.coordinator.notifyStateChanged();
  }

  isPaused(): boolean {
    return this.paused;
  }

  decide(purpose: TunnelRequestPurpose, options: RequestBudgetRunOptions = {}): RequestBudgetDecision {
    const now = Date.now();
    this.prune(now);

    const manualHealthOverride = options.userInitiated && purpose === "health" && this.config.allowManualOverride;
    if (this.paused && !manualHealthOverride) return this.deny(now, purpose, "paused");
    if (this.config.disabledPurposes?.includes(purpose)) return this.deny(now, purpose, "offline");
    if (this.config.pauseWhenHidden && this.hidden && !options.userInitiated && !options.visibleBypass && purpose !== "health" && purpose !== "job_dispatch" && purpose !== "job_reconcile") {
      return this.deny(now, purpose, "hidden");
    }
    return { allowed: true };
  }

  async run<T>(
    purpose: TunnelRequestPurpose,
    fn: () => Promise<T>,
    options: RequestBudgetRunOptions = {},
  ): Promise<T> {
    const decision = this.decide(purpose, options);
    if (!decision.allowed) throw new RequestBudgetDeniedError(purpose, decision);
    let queued = true;
    const releasePromise = this.coordinator.acquire(
      requestPool(purpose, options), this.scopeKey, purpose, options.signal,
      () => this.decide(purpose, options),
      (waitMs) => {
        queued = false;
        this.queued = Math.max(0, this.queued - 1);
        this.queueWaitMsLast = waitMs;
        this.recordEvent({ at: Date.now(), purpose, allowed: true });
        this.lastDeniedReason = undefined;
        this.inFlight += 1;
      },
    );
    this.queued += 1;
    const release = await releasePromise.catch((error) => {
      if (queued) this.queued = Math.max(0, this.queued - 1);
      queued = false;
      if (error instanceof RequestBudgetDeniedError && error.decision.reason === "queue_full") {
        this.recordEvent({ at: Date.now(), purpose, allowed: false, reason: error.decision.reason });
        this.lastDeniedReason = error.decision.reason;
      }
      throw error;
    });
    try {
      return await fn();
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      release();
    }
  }

  snapshot(): RequestBudgetSnapshot {
    const now = Date.now();
    this.prune(now);
    return {
      paused: this.paused,
      hidden: this.hidden,
      inFlight: this.inFlight,
      queued: this.queued,
      globalInFlight: this.coordinator.globalInFlight,
      transferInFlight: this.coordinator.transferInFlight,
      emergencyInFlight: this.coordinator.emergencyInFlight,
      ...this.coordinator.limits,
      queueWaitMsLast: this.queueWaitMsLast,
      maxQueueDepth: this.coordinator.maxQueueDepth,
      coalescedRequests: this.coalescedRequests,
      retries: this.retries,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
      requestsLastMinute: this.allowedEventCount,
      deniedLastMinute: this.deniedEventCount,
      lastAllowedAt: this.lastAllowedAt === undefined ? undefined : new Date(this.lastAllowedAt).toISOString(),
      lastDeniedReason: this.lastDeniedReason,
    };
  }

  private deny(
    now: number,
    purpose: TunnelRequestPurpose,
    reason: RequestBudgetBlockReason,
    retryAfterMs?: number,
  ): RequestBudgetDecision {
    this.recordEvent({ at: now, purpose, allowed: false, reason });
    this.lastDeniedReason = reason;
    return { allowed: false, reason, retryAfterMs };
  }

  private recordEvent(event: BudgetEvent): void {
    this.events.push(event);
    if (this.events.length - this.eventStart > 256) this.eventStart += this.events.length - this.eventStart - 256;
    const eventSecond = Math.floor(event.at / 1000);
    const lastBucket = this.eventBuckets[this.eventBuckets.length - 1];
    const second = Math.max(lastBucket?.second ?? eventSecond, eventSecond);
    let bucket = lastBucket?.second === second ? lastBucket : undefined;
    if (!bucket) {
      bucket = { second, allowed: 0, denied: 0 };
      this.eventBuckets.push(bucket);
      if (this.eventBuckets.length - this.eventBucketStart > 61) {
        const dropped = this.eventBuckets[this.eventBucketStart++];
        if (dropped) {
          this.allowedEventCount = Math.max(0, this.allowedEventCount - dropped.allowed);
          this.deniedEventCount = Math.max(0, this.deniedEventCount - dropped.denied);
        }
      }
    }
    if (event.allowed) {
      bucket.allowed += 1;
      this.allowedEventCount += 1;
      this.lastAllowedAt = event.at;
    } else {
      bucket.denied += 1;
      this.deniedEventCount += 1;
    }
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.eventBucketStart < this.eventBuckets.length && this.eventBuckets[this.eventBucketStart]!.second * 1000 < cutoff) {
      const bucket = this.eventBuckets[this.eventBucketStart++];
      if (bucket) {
        this.allowedEventCount = Math.max(0, this.allowedEventCount - bucket.allowed);
        this.deniedEventCount = Math.max(0, this.deniedEventCount - bucket.denied);
      }
    }
    if (this.lastAllowedAt !== undefined && this.lastAllowedAt < cutoff) this.lastAllowedAt = undefined;
    if (this.eventStart >= 256 && this.eventStart * 2 >= this.events.length) {
      this.events.splice(0, this.eventStart);
      this.eventStart = 0;
    }
    if (this.eventBucketStart >= 32 && this.eventBucketStart * 2 >= this.eventBuckets.length) {
      this.eventBuckets.splice(0, this.eventBucketStart);
      this.eventBucketStart = 0;
    }
  }
}

function requestPool(purpose: TunnelRequestPurpose, options: RequestBudgetRunOptions): RequestPool {
  if (purpose === "file_transfer") return "transfer";
  if (purpose === "stop" || purpose === "job_reconcile" || (purpose === "health" && options.userInitiated)) return "emergency";
  return "control";
}
