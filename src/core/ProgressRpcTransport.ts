import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";

/** A long loopback RPC returns headers only after its work finishes. Native
 * fetch has an independent 300s headers deadline despite live SSE progress.
 * The caller's progress watchdog and signal own the deadline instead. */
export function postProgressRpc(url: URL, options: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response> {
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return Promise.reject(new Error("Progress RPC requires a loopback endpoint"));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method: "POST", headers: options.headers, signal: options.signal,
      agent: false, timeout: 0 }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      try {
        const status = incoming.statusCode || 500;
        const noBody = [204, 205, 304].includes(status);
        if (noBody) incoming.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.once("error", reject);
    request.end(options.body);
  });
}
