import { randomUUID } from "node:crypto";

/** Only the pending exact payload can be answered, once. No persistent approval flag. */
export class RunConfirmation {
  private pending?: { id: string; payload: any; resolve(value: string): void };
  private opening = false;
  private nativeTail: Promise<any> = Promise.resolve();
  private nativeRequests = new Set<{ operationId?: string; cancel(): void }>();
  async ask(host: any, payload: any, signal?: AbortSignal): Promise<string> {
    if (typeof host.showNativeRunConfirmation === "function") return this.askNative(host, payload, signal);
    if (this.pending || this.opening) throw new Error("已有路径确认窗口，请先完成或取消。");
    this.opening = true;
    try { await host.openPanelAt("execution", "execution-plan-list", { userInitiated: true }); }
    finally { this.opening = false; }
    if (signal?.aborted) return "cancel";
    return new Promise(resolve => {
      const finish = (value: string) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending = undefined;
        void host.view?.webview.postMessage({ type: "planRunConfirmationClosed" }); resolve(value); };
      const cancel = () => finish("cancel");
      const timer = setTimeout(cancel, 20 * 60 * 1000); timer.unref?.();
      this.pending = { id: randomUUID(), payload, resolve: finish };
      signal?.addEventListener("abort", cancel, { once: true });
      this.replay(host);
    });
  }
  private askNative(host: any, payload: any, signal?: AbortSignal): Promise<string> {
    const frozen = JSON.parse(JSON.stringify(payload));
    let cancelled = false, resolveResult!: (value: string) => void;
    const result = new Promise<string>(resolve => { resolveResult = resolve; });
    const request = { operationId: frozen.operationId, cancel: () => { cancelled = true; resolveResult("cancel"); } };
    this.nativeRequests.add(request);
    signal?.addEventListener("abort", request.cancel, { once: true });
    if (signal?.aborted) request.cancel();
    this.nativeTail = this.nativeTail.catch(() => {}).then(async () => {
      if (cancelled) return;
      const answer = await host.showNativeRunConfirmation(frozen);
      if (!cancelled) resolveResult(frozen.groups.some((group: any) => !group.disabled && group.value === answer) ? answer : "cancel");
    }).catch(() => resolveResult("cancel")).finally(() => {
      this.nativeRequests.delete(request); signal?.removeEventListener("abort", request.cancel);
    });
    return result;
  }
  replay(host: any): void {
    if (this.pending) void host.view?.webview.postMessage({ type: "planRunConfirmation", requestId: this.pending.id, payload: this.pending.payload });
  }
  answer(message: any): void {
    const pending = this.pending;
    if (!pending || pending.id !== message.requestId) return;
    const choice = String(message.choice || "cancel");
    if (choice !== "cancel" && !pending.payload.groups.some((group: any) => group.value === choice && !group.disabled)) return;
    pending.resolve(choice);
  }
  cancel(operationId?: string): void {
    for (const request of this.nativeRequests) if (!operationId || request.operationId === operationId) request.cancel();
    if (!operationId || this.pending?.payload.operationId === operationId) this.pending?.resolve("cancel");
  }
}
