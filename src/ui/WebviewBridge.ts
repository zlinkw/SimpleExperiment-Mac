export interface WebviewLike {
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
}

export class WebviewBridge {
  private timer?: NodeJS.Timeout;
  private pending: unknown[] = [];

  constructor(private readonly webview: WebviewLike, private readonly batchMs = 200) {}

  post(type: string, payload: Record<string, unknown>): void {
    this.pending.push({ type, ...payload });
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.batchMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 1) await this.webview.postMessage(batch[0]);
    else if (batch.length) await this.webview.postMessage({ type: "batch", messages: batch });
  }
}

