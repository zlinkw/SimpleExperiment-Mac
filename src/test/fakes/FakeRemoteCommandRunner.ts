export interface FakeRemoteCommand {
  serverId: string;
  command: string;
  purpose?: string;
  timeoutMs?: number;
}

export interface FakeRemoteCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  delayMs?: number;
}

export class FakeRemoteCommandRunner {
  readonly calls: FakeRemoteCommand[] = [];
  private handlers: Array<{ match: RegExp | string; result: FakeRemoteCommandResult | ((command: FakeRemoteCommand) => FakeRemoteCommandResult | Promise<FakeRemoteCommandResult>) }> = [];

  on(match: RegExp | string, result: FakeRemoteCommandResult | ((command: FakeRemoteCommand) => FakeRemoteCommandResult | Promise<FakeRemoteCommandResult>)): this {
    this.handlers.push({ match, result });
    return this;
  }

  async run(serverId: string, command: string, options: { purpose?: string; timeoutMs?: number } = {}): Promise<FakeRemoteCommandResult> {
    const call = { serverId, command, ...options };
    this.calls.push(call);
    const handler = this.handlers.find((item) => typeof item.match === "string" ? command.includes(item.match) : item.match.test(command));
    const result = handler
      ? typeof handler.result === "function" ? await handler.result(call) : handler.result
      : { code: 0, stdout: "", stderr: "" };
    if (result.delayMs && options.timeoutMs && result.delayMs > options.timeoutMs) {
      return { code: 255, stdout: "", stderr: "timeout" };
    }
    return result;
  }
}


