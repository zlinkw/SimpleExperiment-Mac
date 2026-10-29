import { assetRepository } from "../platform/UpdateDistribution";
import { ComponentUpdate, PluginUpdatePlan, componentUpdate, currentTargetPlatform, planPairedUpdates,
  EXPERIMENT_EXTENSION_ID, EXPERIMENT_UPDATE_REPO, SFTP_EXTENSION_ID, SFTP_UPDATE_REPO } from "../features/ExtensionUpdates";

interface CacheEntry { bytes: Buffer; etag: string; until: number }
const REPOS = [SFTP_UPDATE_REPO, EXPERIMENT_UPDATE_REPO];
export function assertUpdateUrl(value: string, repo?: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !(repo ? [assetRepository(repo)] : REPOS.map(assetRepository)).some(r => url.hostname === "api.github.com" && url.pathname === `/repos/${r}/releases/latest`
      || url.hostname === "github.com" && url.pathname.startsWith(`/${r}/releases/download/`) && !/%2f|%5c|%2e/i.test(url.pathname)))
    throw new Error("更新来源不属于已配置的 Mac 插件公开 Release。");
}

/** Proven GitHub quota exhaustion: a temporary deferral with a concrete retry time,
 * NOT a check failure. Callers may report it as a waiting state but must not render
 * it as "检查失败" and must not treat cached data as freshly verified. */
export class RateLimitedError extends Error {
  constructor(message: string, readonly retryAt: number) { super(message); this.name = "RateLimitedError"; }
}
export interface RetryStore { load(): number | Promise<number>; save(at: number): void | Promise<void> }

/** Mac's ETag/single-flight/backoff client, using Windows' existing stable Releases. */
export class ReleaseClient {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<Buffer>>();
  private checking?: Promise<PluginUpdatePlan>;
  private retryAt = 0;
  private retryLoaded?: Promise<void>;
  private failures = 0;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now,
    private readonly retryStore?: RetryStore) {}
  /** The persisted backoff is async (globalState); load once and keep request() synchronous
   * so single-flight identity (request === request) stays proven by the existing tests. */
  private loadRetryAt(): Promise<void> {
    // Promise.resolve().then(...) also catches a synchronous throw from load(); a
    // persisted window is honored only while finite and inside the client's own 24h
    // cap, so a corrupt far-future value can never lock checks out forever.
    return this.retryLoaded ??= Promise.resolve().then(() => this.retryStore?.load()).then(at => {
      if (typeof at === "number" && Number.isFinite(at) && at > this.retryAt && at > this.now() && at <= this.now() + 86400000) this.retryAt = at;
    }, () => { /* No usable persisted backoff: in-memory backoff still applies below. */ });
  }
  request(url: string, maxBytes: number, manual = false): Promise<Buffer> {
    assertUpdateUrl(url);
    const pending = this.inflight.get(url); if (pending) return pending;
    const result = this.loadRetryAt().then(() => {
      const cached = this.cache.get(url);
      if (!manual && cached && cached.until > this.now()) return cached.bytes;
      if (this.retryAt > this.now()) throw new RateLimitedError(`GitHub 限流；${new Date(this.retryAt).toISOString()} 后重试。`, this.retryAt);
      return this.fetchBytes(url, maxBytes, cached);
    }).finally(() => this.inflight.delete(url));
    this.inflight.set(url, result); return result;
  }
  private async fetchBytes(url: string, maxBytes: number, cached?: CacheEntry): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), maxBytes > 4 * 1024 * 1024 ? 120000 : 20000);
    try {
      const response = await this.fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "SimpleExperiment-Windows",
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}) }, signal: controller.signal });
      if (response.status === 304 && cached) { cached.until = this.now() + 300000; return cached.bytes; }
      if (!response.ok) {
        const bytes = await this.readResponse(response, 16384).catch(() => Buffer.alloc(0));
        let rateMessage = false;
        try { rateMessage = /secondary rate limit|API rate limit exceeded|abuse detection mechanism/i.test(JSON.parse(bytes.toString("utf8"))?.message || ""); } catch { /* Unproven 403 is not quota exhaustion. */ }
        const retry = response.headers.get("retry-after");
        const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now()) : NaN;
        const primary = response.headers.get("x-ratelimit-remaining") === "0";
        if (response.status === 429 || response.status === 403 && (primary || Number.isFinite(retryMs) && retryMs >= 0 || rateMessage)) {
          this.failures++;
          const reset = primary ? Number(response.headers.get("x-ratelimit-reset")) * 1000 - this.now() : 0;
          this.retryAt = this.now() + Math.min(86400000, Math.max(60000, Number.isFinite(retryMs) ? retryMs : 0, Number.isFinite(reset) ? reset : 0,
            Math.min(1800000, 60000 * 2 ** Math.min(this.failures - 1, 5))));
          // Await the persistence before settling the check (a reload right after the
          // error must see the window); a sync throw or async reject keeps the in-memory
          // backoff and is stated openly inside the same RateLimitedError — never silent.
          let persisted = true;
          if (this.retryStore) { try { await this.retryStore.save(this.retryAt); } catch { persisted = false; } }
          throw new RateLimitedError(`GitHub HTTP ${response.status}；限流至 ${new Date(this.retryAt).toISOString()}。`
            + (this.retryStore && !persisted ? "（退避记录保存失败：重启后可能需按下一次响应重新退避）" : ""), this.retryAt);
        }
        throw new Error(`GitHub 检查失败：HTTP ${response.status}${response.status === 403 ? "，访问被拒绝；未确认限流" : ""}。`);
      }
      const bytes = await this.readResponse(response, maxBytes); this.failures = 0;
      if (maxBytes <= 4 * 1024 * 1024) {
        this.cache.set(url, { bytes, etag: response.headers.get("etag") || "", until: this.now() + 300000 });
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      }
      return bytes;
    } finally { clearTimeout(timer); }
  }
  private async readResponse(response: Response, maxBytes: number): Promise<Buffer> {
    const reader = response.body?.getReader(); if (!reader) throw new Error("GitHub 响应为空。");
    const chunks: Buffer[] = []; let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("GitHub 响应过大。");
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength; if (size > maxBytes) throw new Error("GitHub 响应超出上限。");
        chunks.push(Buffer.from(item.value));
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    return Buffer.concat(chunks, size);
  }
  check(installed: (id: string) => string, manual = false): Promise<PluginUpdatePlan> {
    if (this.checking) return this.checking;
    this.checking = this.checkReleases(installed, manual).finally(() => { this.checking = undefined; }); return this.checking;
  }
  private async checkReleases(installed: (id: string) => string, manual: boolean): Promise<PluginUpdatePlan> {
    const parts = await Promise.all(REPOS.map(async repo => {
      const raw = JSON.parse((await this.request(`https://api.github.com/repos/${repo}/releases/latest`, 4 * 1024 * 1024, manual)).toString("utf8"));
      if (raw.draft !== false || raw.prerelease !== false || typeof raw.tag_name !== "string" || !Array.isArray(raw.assets)) throw new Error(`${repo} 不是有效的稳定 Release。`);
      for (const asset of raw.assets) if (typeof asset?.browser_download_url === "string") assertUpdateUrl(asset.browser_download_url, repo);
      const experiment = repo === EXPERIMENT_UPDATE_REPO;
      const component = componentUpdate(experiment ? EXPERIMENT_EXTENSION_ID : SFTP_EXTENSION_ID, repo, experiment ? "SimpleExperiment" : "SimpleSFTP",
        installed(experiment ? EXPERIMENT_EXTENSION_ID : SFTP_EXTENSION_ID),
        { ...raw, tagName: raw.tag_name, htmlUrl: raw.html_url, publishedAt: raw.published_at }, experiment ? "simple-experiment" : "simple-sftp", currentTargetPlatform());
      if (component.vsix) component.vsix = { ...component.vsix, digest: `sha256:${await this.checksum(component)}` };
      return component;
    }));
    const plan = planPairedUpdates(parts[1], parts[0]);
    if (plan.status === "error") throw new Error(plan.message);
    return plan;
  }
  async checksum(component: ComponentUpdate): Promise<string> {
    const direct = /^sha256:([a-f0-9]{64})$/i.exec(component.vsix?.digest || "")?.[1];
    if (direct) return direct.toLowerCase();
    if (!component.checksum) throw new Error(`${component.label} 缺少可信 SHA-256。`);
    assertUpdateUrl(component.checksum.url, component.repo);
    const text = (await this.request(component.checksum.url, 4096, true)).toString("utf8").trim();
    const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(text);
    if (!match || match[2] !== component.vsix?.name) throw new Error("更新 SHA-256 清单未绑定该精确资产。");
    return match[1].toLowerCase();
  }
}
