import * as http from "node:http";
import * as net from "node:net";
import { assertLocalhost } from "./TunnelGateway";

export interface TensorBoardAgentEndpoint {
  localHost: string;
  localPort: number;
  token?: string;
}

interface ActiveProxy {
  server: http.Server;
  url: string;
  endpoint: TensorBoardAgentEndpoint;
  remotePort: number;
  sessionPrefix: string;
  sockets: Set<net.Socket>;
  upstreamRequests: Set<http.ClientRequest>;
  activeRequestCount: number;
  closing: boolean;
  closePromise?: Promise<void>;
}

export class TensorBoardLocalProxy {
  private readonly active = new Map<string, ActiveProxy>();
  private readonly opening = new Map<string, Promise<string>>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposed = false;

  async open(serverId: string, endpoint: TensorBoardAgentEndpoint, remotePort: number, sessionPrefix: string): Promise<string> {
    if (this.disposed) throw new Error("TensorBoard 代理已释放");
    const pending = this.opening.get(serverId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.open(serverId, endpoint, remotePort, sessionPrefix);
    }
    const task = this.openExclusive(serverId, endpoint, remotePort, sessionPrefix);
    this.opening.set(serverId, task);
    try { return await task; }
    finally { if (this.opening.get(serverId) === task) this.opening.delete(serverId); }
  }

  private async openExclusive(serverId: string, endpoint: TensorBoardAgentEndpoint, remotePort: number, sessionPrefix: string): Promise<string> {
    assertLocalhost(endpoint.localHost);
    if (!Number.isInteger(endpoint.localPort) || endpoint.localPort < 1024 || endpoint.localPort > 65535)
      throw new Error("Agent 本机转发端口无效");
    if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535)
      throw new Error("TensorBoard 远端端口无效");
    const previous = this.active.get(serverId);
    if (previous && previous.remotePort === remotePort && previous.sessionPrefix === sessionPrefix &&
        previous.endpoint.localHost === endpoint.localHost &&
        previous.endpoint.localPort === endpoint.localPort &&
        previous.endpoint.token === endpoint.token) return previous.url;
    await this.close(serverId);
    if (this.disposed) throw new Error("TensorBoard 代理已释放");

    let active: ActiveProxy | undefined;
    const server = http.createServer((browserRequest, browserResponse) => {
      if (!active || active.closing) {
        browserResponse.writeHead(503, { "Connection": "close", "Cache-Control": "no-store" }).end();
        return;
      }
      if (active.activeRequestCount >= 8) {
        browserResponse.writeHead(503, { "Connection": "close", "Cache-Control": "no-store", "Retry-After": "2" }).end();
        return;
      }
      active.activeRequestCount += 1;
      void this.forward(browserRequest, browserResponse, endpoint, remotePort, sessionPrefix, active).catch((error) => {
        if (!browserResponse.headersSent) browserResponse.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        if (!browserResponse.destroyed) browserResponse.end(`TensorBoard 代理失败：${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        if (active) active.activeRequestCount = Math.max(0, active.activeRequestCount - 1);
      });
    });
    server.maxConnections = 16;
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.setTimeout(30_000, (socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定 TensorBoard 本地入口端口");
    const url = `http://127.0.0.1:${address.port}/`;
    active = { server, url, endpoint, remotePort, sessionPrefix, sockets: new Set(), upstreamRequests: new Set(), activeRequestCount: 0, closing: false };
    this.active.set(serverId, active);
    return url;
  }

  url(serverId: string): string | undefined {
    return this.active.get(serverId)?.url;
  }

  async close(serverId: string): Promise<void> {
    const pendingClose = this.closing.get(serverId);
    if (pendingClose) return pendingClose;
    const item = this.active.get(serverId);
    if (!item) return;
    this.active.delete(serverId);
    if (item.closePromise) return item.closePromise;
    item.closing = true;
    item.closePromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1_500);
      timer.unref?.();
      item.server.close(finish);
      for (const request of item.upstreamRequests) request.destroy(new Error("TensorBoard 代理已关闭"));
      for (const socket of item.sockets) socket.destroy();
    });
    this.closing.set(serverId, item.closePromise);
    try { await item.closePromise; }
    finally { if (this.closing.get(serverId) === item.closePromise) this.closing.delete(serverId); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.opening.values()].map((task) => task.catch(() => undefined)));
    await Promise.all([...this.active.keys()].map((id) => this.close(id)));
  }

  private async forward(request: http.IncomingMessage, response: http.ServerResponse,
                        endpoint: TensorBoardAgentEndpoint, remotePort: number, sessionPrefix: string, active: ActiveProxy): Promise<void> {
    const socket = request.socket;
    active.sockets.add(socket);
    socket.once("close", () => active.sockets.delete(socket));
    let upstream: http.ClientRequest | undefined;
    const cancelUpstream = () => {
      if (upstream && !upstream.destroyed) upstream.destroy(new Error("TensorBoard 浏览器请求已关闭"));
    };
    request.once("aborted", cancelUpstream);
    response.once("close", () => {
      if (!response.writableEnded) cancelUpstream();
    });
    if (active.closing) {
      response.writeHead(503, { "Connection": "close", "Cache-Control": "no-store" }).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "Connection": "close" });
      if (!response.destroyed) response.end("TensorBoard 浏览器请求未完整发送");
      return;
    }
    const body = Buffer.concat(chunks);
    const path = String(request.url || "/");
    const agentPath = `/api/tensorboard/proxy?port=${remotePort}&sessionPrefix=${encodeURIComponent(sessionPrefix)}&path=${encodeURIComponent(path)}`;
    const headers: Record<string, string | number> = { Accept: String(request.headers.accept || "*/*") };
    if (endpoint.token) headers["X-Simple-Agent-Token"] = endpoint.token;
    if (body.length) {
      headers["Content-Type"] = String(request.headers["content-type"] || "application/octet-stream");
      headers["Content-Length"] = body.length;
    }
    const agentRequest = http.request({ host: endpoint.localHost, port: endpoint.localPort,
      path: agentPath, method: request.method, headers, timeout: 15000 }, (agentResponse) => {
      const outgoing: Record<string, string | string[]> = {};
      for (const name of ["content-type", "content-length", "cache-control", "location", "set-cookie"] as const) {
        const value = agentResponse.headers[name];
        if (value) outgoing[name] = value;
      }
      response.writeHead(agentResponse.statusCode || 502, outgoing);
      agentResponse.once("aborted", cancelUpstream);
      agentResponse.once("error", (error) => {
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        if (!response.destroyed) response.end(`TensorBoard 响应失败：${error.message}`);
      });
      agentResponse.pipe(response);
    });
    upstream = agentRequest;
    active.upstreamRequests.add(agentRequest);
    agentRequest.once("close", () => active.upstreamRequests.delete(agentRequest));
    agentRequest.once("timeout", () => agentRequest.destroy(new Error("Agent TensorBoard 代理超时")));
    agentRequest.once("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`TensorBoard 代理失败：${error.message}`);
    });
    agentRequest.end(body);
  }
}
