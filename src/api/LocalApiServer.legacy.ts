import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { atomicWriteText } from "../state/StateStore";
import { operationOutcomeFor } from "../core/OperationOutcome";

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_MAX_EVENTS = 64;
const DEFAULT_EVENT_BUFFER_LIMIT = 128;
const DEFAULT_EVENT_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_SSE_TIMEOUT_MS = 30_000;
const DEFAULT_SSE_MAX_CLIENTS = 8;
const DEFAULT_SSE_MAX_PENDING_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PORT = 65535;
const VIEWER_SESSION_SECONDS = 30 * 24 * 60 * 60;
const VIEWER_RENEW_SECONDS = 7 * 24 * 60 * 60;

export type ApiParams = Record<string, unknown>;
// Read-only handlers may stop work on disconnect; mutation handlers should ignore it and keep publishing their operation receipt.
export interface ApiHandlerContext {
  signal: AbortSignal;
}
export type ApiHandler = (params: ApiParams, server: LocalApiServer, context: ApiHandlerContext) => unknown | Promise<unknown>;

export class LocalApiError extends Error {
  apiCode: number;
  apiData?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "LocalApiError";
    this.apiCode = code;
    if (data !== undefined) this.apiData = data;
  }
}

export function confirmationRequired(preview: unknown): LocalApiError {
  return new LocalApiError(2001, "CONFIRM_REQUIRED", preview);
}

interface LocalApiServerOptions {
  name: string;
  version: string;
  preferredPort?: number;
  preferredPortRetryMs?: number;
  token?: string;
  viewerSessionKey?: string;
  viewerSessionScope?: string;
  methods?: Record<string, ApiHandler>;
  discoveryPath?: string;
  maxEvents?: number;
  maxEventBufferBytes?: number;
  maxSseClients?: number;
  maxSsePendingBytes?: number;
  sseTimeoutMs?: number;
  scalarViewer?: {
    html: string;
    query: (params: ApiParams, endpointId: string, context: ApiHandlerContext) => Promise<unknown>;
    native: (method: string, route: string, body: Buffer | undefined, contentType: string, endpointId: string, context: ApiHandlerContext) => Promise<{ status: number; body: Buffer; contentType: string }>;
  };
}

interface PublishedEvent {
  seq: number;
  type: string;
  data: unknown;
  publishedAt: string;
  frame: string;
  bytes: number;
}

type EventListener = (event: PublishedEvent) => void;

function parseRemoteAddress(value: string | undefined): string {
  const raw = String(value || "").toLowerCase();
  if (raw.startsWith("::ffff:") && raw.length > 7) return raw.slice(7);
  return raw;
}

function loopbackRequest(request: http.IncomingMessage): boolean {
  return LOOPBACK_REMOTE_ADDRESSES.has(parseRemoteAddress(request.socket.remoteAddress));
}

function normalParams(value: unknown): ApiParams {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ApiParams : {};
}

function readJsonBody(request: http.IncomingMessage, signal?: AbortSignal): Promise<ApiParams> {
  return readBoundedRequestBody(request, signal).then((bytes) => {
    try {
      const parsed = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ApiParams : {};
    } catch (error) {
      throw new LocalApiError(-32700, "Parse error", { detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

function readBoundedRequestBody(request: http.IncomingMessage, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const finish = (error?: unknown, value?: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value || Buffer.alloc(0));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new LocalApiError(413, "PAYLOAD_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, size));
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new Error("Request body was disconnected before completion."));
    const onSignalAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Request cancelled."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sseGapFrame(reason: string): string {
  return `event: gap\ndata: ${JSON.stringify({ payload: { code: "journal_gap", reason, snapshotRequired: true } })}\n\n`;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function isPortConflict(error: unknown): boolean {
  const value = error as { code?: string };
  return Boolean(value && ["EADDRINUSE", "EACCES"].includes(value.code || ""));
}

function positivePort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export class LocalApiServer {
  readonly name: string;
  readonly version: string;
  readonly host = "127.0.0.1";
  readonly preferredPort: number;
  readonly preferredPortRetryMs: number;
  readonly token: string;
  readonly methods: Record<string, ApiHandler>;
  readonly discoveryPath: string;
  readonly sseTimeoutMs: number;
  readonly maxEvents: number;
  readonly maxEventBufferBytes: number;
  readonly maxSseClients: number;
  readonly maxSsePendingBytes: number;

  private events: PublishedEvent[] = [];
  private eventBufferBytes = 0;
  private listeners = new Set<EventListener>();
  private sseClosers = new Set<() => void>();
  private eventSequence = 0;
  private server?: http.Server;
  private port = 0;
  private startedAt = "";
  private stoppedAt = "";
  private disposed = false;
  private scalarViewer?: LocalApiServerOptions["scalarViewer"];
  private viewerTickets = new Map<string, { expires: number; endpointId: string }>();
  private viewerSessionKey: Buffer;
  private viewerSessionScope: string;
  private readonly viewerEpoch = crypto.randomBytes(12).toString("hex");

  constructor(options: LocalApiServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.preferredPort = positivePort(options.preferredPort, 19766);
    this.preferredPortRetryMs = Math.min(10_000, positiveNumber(options.preferredPortRetryMs, 0));
    this.token =
      options.token
        ? String(options.token)
        : crypto.randomBytes(32).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
    this.methods = options.methods && typeof options.methods === "object" ? options.methods : {};
    this.discoveryPath = options.discoveryPath || "";
    this.sseTimeoutMs = positiveNumber(options.sseTimeoutMs, DEFAULT_SSE_TIMEOUT_MS);
    this.maxEvents = Math.max(1, Math.min(1024, positiveNumber(options.maxEvents, DEFAULT_MAX_EVENTS)));
    this.maxEventBufferBytes = Math.max(1024, positiveNumber(options.maxEventBufferBytes, DEFAULT_EVENT_BUFFER_BYTES));
    this.maxSseClients = Math.max(1, Math.min(64, positiveNumber(options.maxSseClients, DEFAULT_SSE_MAX_CLIENTS)));
    this.maxSsePendingBytes = Math.max(512, positiveNumber(options.maxSsePendingBytes, DEFAULT_SSE_MAX_PENDING_BYTES));
    this.scalarViewer = options.scalarViewer;
    this.viewerSessionKey = /^[a-f0-9]{64}$/i.test(options.viewerSessionKey || "")
      ? Buffer.from(options.viewerSessionKey!, "hex") : crypto.randomBytes(32);
    this.viewerSessionScope = String(options.viewerSessionScope || "");
  }

  private issueViewerSession(endpointId: string, now: number): string {
    const expires = (now + VIEWER_SESSION_SECONDS * 1000).toString(16).padStart(12, "0");
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `${expires}.${nonce}`;
    const signature = crypto.createHmac("sha256", this.viewerSessionKey)
      .update(`${payload}.${this.viewerSessionScope}.${endpointId}`).digest("hex");
    return `${payload}.${signature}`;
  }

  private viewerSessionExpiry(value: string, endpointId: string, now: number): number {
    const match = /^([a-f0-9]{12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
    if (!match) return 0;
    const expires = Number.parseInt(match[1], 16);
    if (!Number.isSafeInteger(expires) || expires <= now) return 0;
    const expected = crypto.createHmac("sha256", this.viewerSessionKey)
      .update(`${match[1]}.${match[2]}.${this.viewerSessionScope}.${endpointId}`).digest();
    const actual = Buffer.from(match[3], "hex");
    return crypto.timingSafeEqual(actual, expected) ? expires : 0;
  }

  viewerUrl(endpointId = ""): string {
    if (!this.server || !this.port || !this.scalarViewer) throw new Error("Scalar viewer is unavailable");
    const ticket = crypto.randomBytes(24).toString("hex");
    this.viewerTickets.set(ticket, { expires: Date.now() + 60_000, endpointId });
    return `http://${this.host}:${this.port}/tensorboard/?ticket=${ticket}&server=${encodeURIComponent(endpointId)}`;
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error("LocalApiServer is disposed");
    await this.listen();
    this.startedAt = new Date().toISOString();
    await this.writeDiscovery();
    return this.discovery();
  }

  private async listen(): Promise<void> {
    const startPort = Math.max(1024, Math.min(this.preferredPort, MAX_PORT));
    const preferredDeadline = Date.now() + this.preferredPortRetryMs;
    while (Date.now() < preferredDeadline) {
      try {
        await this.listenOnce(startPort);
        this.port = startPort;
        return;
      } catch (error) {
        if (!isPortConflict(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (let port = startPort; port <= MAX_PORT; port += 1) {
      try {
        await this.listenOnce(port);
        this.port = port;
        return;
      } catch (error) {
        if (!isPortConflict(error) || port === MAX_PORT) throw error;
      }
    }
  }

  private listenOnce(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          response.end();
        });
      });
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!loopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: "FORBIDDEN_REMOTE" });
      return;
    }
    const url = new URL(request.url || "/", `http://${this.host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/tensorboard" || pathname === "/tensorboard/api" || pathname === "/tensorboard/health" || pathname.startsWith("/api/tensorboard/ui")) {
      await this.handleScalarViewer(request, response, url, pathname);
      return;
    }
    if (!this.authorized(request)) {
      sendJson(response, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/health") {
      sendJson(response, 200, this.health());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/capabilities") {
      sendJson(response, 200, this.capabilities());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/openapi.json") {
      sendJson(response, 200, this.openapi());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/events") {
      this.streamEvents(request, response, url);
      return;
    }
    if (request.method === "POST" && pathname === "/api/v1/rpc") {
      await this.handleRpc(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
  }

  private async handleScalarViewer(request: http.IncomingMessage, response: http.ServerResponse, url: URL, pathname: string): Promise<void> {
    if (!this.scalarViewer) return sendJson(response, 404, { error: "NOT_FOUND" });
    const now = Date.now();
    for (const [key, value] of this.viewerTickets) if (value.expires < now) this.viewerTickets.delete(key);
    const ticket = url.searchParams.get("ticket") || "";
    const issued = this.viewerTickets.get(ticket);
    let referrerEndpoint = "";
    try { referrerEndpoint = new URL(String(request.headers.referer || "")).searchParams.get("server") || ""; } catch {}
    const requestedEndpoint = url.searchParams.get("server") || referrerEndpoint || issued?.endpointId || "";
    const cookieName = `simple_scalar_session_${crypto.createHash("sha256").update(requestedEndpoint).digest("hex").slice(0, 12)}`;
    const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9.]+)`).exec(String(request.headers.cookie || ""))?.[1] || "";
    const expires = this.viewerSessionExpiry(cookie, requestedEndpoint, now);
    let authorized = expires > now;
    if (pathname === "/tensorboard" && request.method === "GET") {
      if (!authorized && issued && issued.expires > now && issued.endpointId === requestedEndpoint) {
        this.viewerTickets.delete(ticket);
        response.setHeader("Set-Cookie", `${cookieName}=${this.issueViewerSession(requestedEndpoint, now)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${VIEWER_SESSION_SECONDS}`);
        authorized = true;
      }
      if (!authorized) return sendJson(response, 401, { error: "VIEWER_SESSION_EXPIRED" });
      if (issued) this.viewerTickets.delete(ticket);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'" });
      response.end(this.scalarViewer.html
        .replaceAll("__SCALAR_VIEWER_SERVER__", JSON.stringify(requestedEndpoint).replace(/</g, "\\u003c"))
        .replaceAll("__SCALAR_VIEWER_EPOCH__", JSON.stringify(this.viewerEpoch)));
      return;
    }
    if (!authorized) return sendJson(response, 401, { error: "VIEWER_SESSION_EXPIRED" });
    if (expires - now < VIEWER_RENEW_SECONDS * 1000)
      response.setHeader("Set-Cookie", `${cookieName}=${this.issueViewerSession(requestedEndpoint, now)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${VIEWER_SESSION_SECONDS}`);
    if (pathname === "/tensorboard/health" && request.method === "GET")
      return sendJson(response, 200, { ok: true, epoch: this.viewerEpoch, version: this.version });
    const origin = String(request.headers.origin || "");
    if (request.method === "POST" && origin !== `http://${this.host}:${this.port}`) return sendJson(response, 403, { error: "INVALID_ORIGIN" });
    const beginRequestScope = () => {
      const controller = new AbortController();
      const onDisconnect = () => {
        if (!response.writableEnded && !controller.signal.aborted)
          controller.abort(new Error("TensorBoard viewer disconnected."));
      };
      request.once("aborted", onDisconnect);
      response.once("close", onDisconnect);
      return {
        signal: controller.signal,
        dispose: () => {
          request.removeListener("aborted", onDisconnect);
          response.removeListener("close", onDisconnect);
        },
      };
    };
    if (pathname === "/tensorboard/api" && request.method === "POST") {
      const scope = beginRequestScope();
      try {
        const params = normalParams(await readJsonBody(request, scope.signal));
        if (scope.signal.aborted) return;
        const result = await this.scalarViewer.query(params, requestedEndpoint, { signal: scope.signal });
        if (!scope.signal.aborted && !response.destroyed) sendJson(response, 200, result);
      } catch (error) {
        if (!scope.signal.aborted && !response.destroyed)
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error), retryAfterMs: Number((error as any)?.decision?.retryAfterMs || 0) });
      } finally {
        scope.dispose();
      }
      return;
    }
    if (pathname.startsWith("/api/tensorboard/ui") && (request.method === "GET" || request.method === "POST")) {
      const scope = beginRequestScope();
      try {
        const body = request.method === "POST" ? await readBoundedRequestBody(request, scope.signal) : undefined;
        if (scope.signal.aborted) return;
        url.searchParams.delete("server");
        const result = await this.scalarViewer.native(request.method, url.pathname + url.search, body,
          String(request.headers["content-type"] || ""), requestedEndpoint, { signal: scope.signal });
        if (scope.signal.aborted || response.destroyed) return;
        response.writeHead(result.status, { "Content-Type": result.contentType, "Content-Length": result.body.length, "Cache-Control": "no-store" });
        response.end(result.body);
      } catch (error) {
        if (!scope.signal.aborted && !response.destroyed)
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        scope.dispose();
      }
      return;
    }
    sendJson(response, 404, { error: "NOT_FOUND" });
  }

  private async handleRpc(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const payload = await readJsonBody(request);
    if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string" || !payload.method) {
      sendJson(response, 400, rpcError(payload?.id, -32600, "Invalid Request"));
      return;
    }
    const id = payload.id;
    const controller = new AbortController();
    const onResponseClosed = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", onResponseClosed);
    try {
      const handler = this.methods[payload.method];
      if (typeof handler !== "function") {
        sendJson(response, 200, rpcError(id, -32601, "Method not found"));
        return;
      }
      const result = await handler(normalParams(payload.params), this, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: result === undefined ? null : result,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      const code = Number(error instanceof LocalApiError ? error.apiCode : (error as { apiCode?: unknown })?.apiCode) || -32000;
      const message = error instanceof Error ? error.message : String(error);
      const originalData = error instanceof LocalApiError && error.apiData !== undefined
        ? error.apiData
        : undefined;
      const data = originalData && typeof originalData === "object" && !Array.isArray(originalData)
        ? { ...(originalData as Record<string, unknown>), method: payload.method, operationOutcome: operationOutcomeFor(error) }
        : { method: payload.method, ...(originalData !== undefined ? { detail: originalData } : {}), operationOutcome: operationOutcomeFor(error) };
      sendJson(response, 200, rpcError(id, code, message, data));
    } finally {
      response.removeListener("close", onResponseClosed);
    }
  }

  private authorized(request: http.IncomingMessage): boolean {
    const expected = Buffer.from(String(this.token || ""));
    const header = String(request.headers.authorization || "");
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || expected.length !== match[1].length) return false;
    const actual = Buffer.from(match[1]);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  publish(event: { type?: string; data?: unknown }): PublishedEvent {
    const data = event && event.data !== undefined ? event.data : null;
    const serializedData = JSON.stringify(data);
    const type = String((event && event.type) || "event").replace(/[\r\n]/g, "").slice(0, 128) || "event";
    const item: PublishedEvent = {
      seq: this.eventSequence + 1,
      type,
      data,
      publishedAt: new Date().toISOString(),
      frame: `id: ${this.eventSequence + 1}\nevent: ${type}\ndata: ${serializedData}\n\n`,
      bytes: 0,
    };
    item.bytes = Buffer.byteLength(item.frame, "utf8");
    this.eventSequence = item.seq;
    this.events.push(item);
    this.eventBufferBytes += item.bytes;
    while (this.events.length > DEFAULT_EVENT_BUFFER_LIMIT || this.eventBufferBytes > this.maxEventBufferBytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.eventBufferBytes = Math.max(0, this.eventBufferBytes - removed.bytes);
    }
    for (const listener of [...this.listeners]) listener(item);
    return item;
  }

  private streamEvents(request: http.IncomingMessage, response: http.ServerResponse, url: URL): void {
    if (this.listeners.size >= this.maxSseClients) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.end(sseGapFrame("subscriber_limit"));
      return;
    }
    const since = positiveNumber(Number(url.searchParams.get("since") || 0), 0);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let sent = 0;
    let closed = false;
    let backpressured = false;
    let finishWhenDrained = false;
    let queuedBytes = 0;
    const pending: Array<{ frame: string; bytes: number }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeFromServer: () => void = () => undefined;
    const gapFrame = sseGapFrame("slow_consumer");
    const gapBytes = Buffer.byteLength(gapFrame, "utf8");
    const close = (endResponse = true) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      this.listeners.delete(listener);
      this.sseClosers.delete(closeFromServer);
      response.removeListener("drain", onDrain);
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClosed);
      response.removeListener("error", onResponseError);
      if (endResponse && !response.writableEnded && !response.destroyed) {
        try { response.end(); } catch { /* peer may disappear between the state check and write */ }
      }
    };
    const sendGap = () => {
      if (closed) return;
      pending.length = 0;
      queuedBytes = 0;
      closed = true;
      if (timer) clearTimeout(timer);
      this.listeners.delete(listener);
      this.sseClosers.delete(closeFromServer);
      response.removeListener("drain", onDrain);
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClosed);
      response.removeListener("error", onResponseError);
      if (!response.writableEnded && !response.destroyed) {
        try { response.end(gapFrame); } catch { /* the gap is best effort after peer failure */ }
      }
    };
    const pendingBytes = () => Number(response.writableLength || 0) + queuedBytes;
    const writeFrame = (frame: string): boolean => {
      try { return response.write(frame); }
      catch { close(false); return false; }
    };
    const sendFrame = (frame: string, bytes: number) => {
      if (closed || sent >= this.maxEvents) return;
      if (pendingBytes() + bytes + gapBytes > this.maxSsePendingBytes) { sendGap(); return; }
      sent += 1;
      if (backpressured || pending.length) {
        pending.push({ frame, bytes });
        queuedBytes += bytes;
      } else if (!writeFrame(frame)) {
        backpressured = true;
      }
      if (sent >= this.maxEvents) {
        finishWhenDrained = true;
        if (!backpressured && !pending.length) close();
      }
    };
    const sendEvent = (item: PublishedEvent) => sendFrame(item.frame, item.bytes);
    const onDrain = () => {
      if (closed) return;
      backpressured = false;
      while (!backpressured && pending.length && !closed) {
        const item = pending.shift();
        if (!item) break;
        queuedBytes = Math.max(0, queuedBytes - item.bytes);
        if (!writeFrame(item.frame)) backpressured = true;
      }
      if (!closed && finishWhenDrained && !backpressured && !pending.length) close();
    };
    const onRequestAborted = () => close(false);
    const onResponseClosed = () => close(false);
    const onResponseError = () => close(false);
    closeFromServer = () => close();
    const listener: EventListener = (item) => sendEvent(item);
    response.on("drain", onDrain);
    request.on("aborted", onRequestAborted);
    response.on("close", onResponseClosed);
    response.on("error", onResponseError);
    this.listeners.add(listener);
    this.sseClosers.add(closeFromServer);
    const firstAvailableSeq = this.events[0]?.seq;
    const historyGap = firstAvailableSeq !== undefined
      ? since < firstAvailableSeq - 1
      : since < this.eventSequence;
    if (historyGap) {
      sendGap();
      return;
    }
    for (const item of this.events) {
      if (item.seq > since) sendEvent(item);
      if (closed) return;
    }
    if (sent >= this.maxEvents && !backpressured && !pending.length) {
      close();
      return;
    }
    timer = setTimeout(close, this.sseTimeoutMs);
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      pid: process.pid,
      port: this.port,
      startedAt: this.startedAt,
    };
  }

  capabilities(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      transport: ["http", "cli"],
      rpc: "json-rpc-2.0",
      methods: Object.keys(this.methods).sort(),
      confirmation: { required: true, categories: ["confirm", "pathConfirmed"] },
    };
  }

  openapi(): Record<string, unknown> {
    const methods = Object.keys(this.methods).sort();
    return {
      openapi: "3.0.0",
      info: { title: `${this.name} Local API`, version: this.version },
      servers: [{ url: `http://127.0.0.1:${this.port}` }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths: {
        "/api/v1/rpc": {
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "method"],
                    properties: {
                      jsonrpc: { const: "2.0" },
                      id: { type: ["string", "number", "null"] },
                      method: { type: "string", enum: methods },
                      params: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: "JSON-RPC response" } },
          },
        },
        "/api/v1/health": { get: { responses: { 200: { description: "Health" } } } },
        "/api/v1/capabilities": { get: { responses: { 200: { description: "Capabilities" } } } },
        "/api/v1/events": { get: { responses: { 200: { description: "Bounded SSE stream" } } } },
      },
    };
  }

  discovery(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      baseUrl: `http://${this.host}:${this.port}`,
      host: this.host,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      status: this.disposed ? "stopped" : "running",
      ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
    };
  }

  private async writeDiscovery(): Promise<void> {
    if (!this.discoveryPath) return;
    await atomicWriteText(this.discoveryPath, `${JSON.stringify(this.discovery(), null, 2)}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stoppedAt = new Date().toISOString();
    for (const closeStream of [...this.sseClosers]) closeStream();
    this.sseClosers.clear();
    let discoveryError: unknown;
    try { await this.writeDiscovery(); } catch (error) { discoveryError = error; }
    if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (discoveryError) throw discoveryError;
  }
}

export { parseRemoteAddress, loopbackRequest };
