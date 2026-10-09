/**
 * CommandBusFactory — CommandBus 工厂
 * 封装 CommandBus 创建与 handler 注册，支持依赖注入，保持与原 API 兼容
 */

import { CommandBus } from "../CommandBus";

export interface CommandBusFactoryOptions {
  singleton?: boolean;
  handlers?: Array<{ type: string; handler: (cmd: any) => any }>;
}

export interface CommandBusFactory {
  create(opts?: CommandBusFactoryOptions): any;
  getShared(): any;
  createWithHandlers(handlers: Array<{ type: string; handler: (cmd: any) => any }>): any;
  resetShared(): void;
}

let sharedBus: any = undefined;

class DefaultCommandBusFactory implements CommandBusFactory {
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) { this.deps = deps; }

  create(opts: CommandBusFactoryOptions = {}): any {
    const bus = new CommandBus();
    const handlers: Array<{ type: string; handler: any }> = (opts.handlers as any) || (this.deps.handlers as any) || [];
    if (!Array.isArray(handlers)) throw new Error("CommandBus handlers must be an array.");
    const unregister: Array<() => void> = [];
    try {
      for (const handler of handlers) {
        if (!handler || typeof handler.type !== "string" || !handler.type.trim() || typeof handler.handler !== "function")
          throw new Error("CommandBus handler requires a non-empty type and callable handler.");
        unregister.push(bus.register(handler.type, handler.handler));
      }
    } catch (error) {
      for (const dispose of unregister.reverse()) dispose();
      throw error;
    }
    if (opts.singleton || this.deps.singleton) sharedBus = bus;
    return bus;
  }

  getShared(): any {
    if (this.deps.commandBus) return assertCommandBus(this.deps.commandBus);
    if (sharedBus) return sharedBus;
    sharedBus = this.create({ singleton: true });
    return sharedBus;
  }

  createWithHandlers(handlers: Array<{ type: string; handler: (cmd: any) => any }>): any {
    return this.create({ handlers });
  }

  resetShared(): void { sharedBus = undefined; }
}

export function createCommandBus(opts?: CommandBusFactoryOptions): any {
  const factory = new DefaultCommandBusFactory();
  return factory.create(opts);
}
export function createCommandBusFactory(deps?: Record<string, unknown>): CommandBusFactory {
  return new DefaultCommandBusFactory(deps);
}
export { DefaultCommandBusFactory };

function assertCommandBus(value: unknown): any {
  if (!value || typeof value !== "object" || typeof (value as any).register !== "function" || typeof (value as any).dispatch !== "function")
    throw new Error("Injected CommandBus does not implement register/dispatch.");
  return value;
}
