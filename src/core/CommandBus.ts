export interface Command<T = unknown> {
  type: string;
  payload?: T;
}

export type CommandHandler<T = unknown> = (command: Command<T>) => Promise<void> | void;

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler[]>();

  register<T = unknown>(type: string, handler: CommandHandler<T>): () => void {
    const list = this.handlers.get(type) || [];
    list.push(handler as CommandHandler);
    this.handlers.set(type, list);
    return () => {
      const next = (this.handlers.get(type) || []).filter((item) => item !== handler);
      if (next.length) this.handlers.set(type, next);
      else this.handlers.delete(type);
    };
  }

  async dispatch<T = unknown>(command: Command<T>): Promise<void> {
    const list = this.handlers.get(command.type) || [];
    if (!list.length) throw new Error(`No command handler registered: ${command.type}`);
    for (const handler of list) await handler(command);
  }
}

