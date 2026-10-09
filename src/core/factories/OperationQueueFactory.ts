/**
 * OperationQueueFactory — OperationQueue 工厂
 * 封装 OperationQueue 创建与全局单例，支持依赖注入与历史上限配置
 */

import { OperationQueue } from "../OperationQueue";

export interface OperationQueueFactoryOptions {
  historyLimit?: number;
  maxPending?: number;
  singleton?: boolean;
}

export interface OperationQueueFactory {
  create(opts?: OperationQueueFactoryOptions): any;
  getShared(): any;
  resetShared(): void;
}

let sharedInstance: any = undefined;

class DefaultOperationQueueFactory implements OperationQueueFactory {
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) { this.deps = deps; }

  create(opts: OperationQueueFactoryOptions = {}): any {
    const historyLimit = opts.historyLimit ?? (this.deps.historyLimit as number) ?? 500;
    const maxPending = opts.maxPending ?? (this.deps.maxPending as number) ?? 256;
    const queue = new OperationQueue(historyLimit, maxPending);
    if (opts.singleton || this.deps.singleton) sharedInstance = queue;
    return queue;
  }

  getShared(): any {
    // 若外部通过 deps 注入了 operationQueue，优先复用
    if (this.deps.operationQueue) return assertOperationQueue(this.deps.operationQueue);
    if (sharedInstance) return sharedInstance;
    const historyLimit = (this.deps.historyLimit as number) ?? 500;
    const maxPending = (this.deps.maxPending as number) ?? 256;
    sharedInstance = new OperationQueue(historyLimit, maxPending);
    return sharedInstance;
  }

  resetShared(): void { sharedInstance = undefined; }
}

export function createOperationQueue(opts?: OperationQueueFactoryOptions): any {
  const factory = new DefaultOperationQueueFactory();
  return factory.create(opts);
}
export function createOperationQueueFactory(deps?: Record<string, unknown>): OperationQueueFactory {
  return new DefaultOperationQueueFactory(deps);
}
export { DefaultOperationQueueFactory };

function assertOperationQueue(value: unknown): any {
  if (!value || typeof value !== "object"
    || typeof (value as any).enqueue !== "function"
    || typeof (value as any).cancel !== "function"
    || typeof (value as any).snapshot !== "function"
    || typeof (value as any).activeExclusiveKeys !== "function")
    throw new Error("Injected OperationQueue does not implement the required scheduling and lifecycle contract.");
  return value;
}
