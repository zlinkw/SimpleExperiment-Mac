/** Control-plane JSON/events only. File transfers use their existing streaming path. */
export const MAX_CONTROL_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export async function readBoundedResponseText(response: Response, onBytes: (bytes: number) => void,
  limit = MAX_CONTROL_RESPONSE_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let finished = false;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("Agent response exceeds control-plane byte limit");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      received += chunk.value.byteLength;
      if (received > limit) throw new Error("Agent response exceeds control-plane byte limit");
      chunks.push(chunk.value);
      onBytes(received);
    }
    return Buffer.concat(chunks, received).toString("utf8");
  } finally {
    // Cancellation must not hold the request slot if an upstream stream ignores cancel().
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** SSE can split UTF-8 and delimiters across reads; bound each frame, not the session. */
export class BoundedSseDecoder {
  private readonly decoder = new TextDecoder();
  private pending = "";
  constructor(private readonly limit = MAX_SSE_EVENT_BYTES) {}
  push(chunk?: Uint8Array): string[] {
    const text = this.pending + this.decoder.decode(chunk, { stream: chunk !== undefined });
    this.pending = "";
    const parts = text.split(/\r?\n\r?\n/);
    const tail = parts.pop() || "";
    for (const part of [...parts, tail]) {
      if (Buffer.byteLength(part, "utf8") > this.limit) throw new Error("Agent SSE frame exceeds control-plane byte limit");
    }
    if (chunk === undefined) { if (tail) parts.push(tail); }
    else this.pending = tail;
    return parts.map(part => part.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim()).join("\n")).filter(Boolean);
  }
}
