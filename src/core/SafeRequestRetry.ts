import { AsyncLocalStorage } from "node:async_hooks";

type Request = {
  controller: AbortController;
  settled: Promise<void>;
  stopChecks: Set<() => Promise<void>>;
  replacing: boolean;
};
const context = new AsyncLocalStorage<Request>();

export class RequestReplacedError extends Error {
  readonly code = "REQUEST_REPLACED";
  constructor() { super("旧请求已被重新执行替代，保留已有产物。"); this.name = "RequestReplacedError"; }
}
export function retryRequestSignal(): AbortSignal | undefined { return context.getStore()?.controller.signal; }
export function assertRetryRequestCurrent(): void { retryRequestSignal()?.throwIfAborted(); }
export function registerRetryStopCheck(check: () => Promise<void>): () => void {
  const request = context.getStore();
  if (request && request.stopChecks.size >= 64) throw new Error("待核实的传输过多，未启动更多传输，请先重试并核对已有请求。");
  request?.stopChecks.add(check);
  return () => { request?.stopChecks.delete(check); };
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("旧请求尚未确认退出，未启动新请求；连接恢复后可再次重试。")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Only explicit requests with identical workspace/action/target keys replace one another. */
export class SafeRequestRetry {
  private requests = new Map<string, Request>();
  constructor(private readonly timeoutMs = 30_000) {}

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.replacing) throw new Error("相同请求正在停止并重试，请等待本次处理。");
      previous.replacing = true;
      previous.controller.abort(new RequestReplacedError());
      const settleDeadline = Date.now() + this.timeoutMs;
      const remainingMs = () => Math.max(1, settleDeadline - Date.now());
      try {
        await bounded(previous.settled, remainingMs());
        for (const check of previous.stopChecks) {
          await bounded(check(), remainingMs());
          previous.stopChecks.delete(check);
        }
      } catch (error) {
        // Keep the old request visible and guarded after an unknown stop result,
        // but allow a later explicit retry to re-check its outstanding receipts.
        previous.replacing = false;
        throw error;
      }
    }
    // Pending unknown outcomes are kept for rechecking; never evict a live guard.
    if (!previous && this.requests.size >= 64) throw new Error("待核实的请求过多，请先核对已有传输状态。");
    let settle!: () => void;
    const request: Request = { controller: new AbortController(), settled: new Promise(resolve => { settle = resolve; }),
      stopChecks: new Set(), replacing: false };
    this.requests.set(key, request);
    try {
      return await context.run(request, async () => {
        const result = await work();
        assertRetryRequestCurrent();
        return result;
      });
    } catch (error) {
      if (request.controller.signal.aborted) throw request.controller.signal.reason;
      throw error;
    } finally {
      settle();
      if (!request.replacing && !request.stopChecks.size && this.requests.get(key) === request) this.requests.delete(key);
    }
  }
}
