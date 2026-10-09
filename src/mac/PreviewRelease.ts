import { ReleaseComponent, verifyVsix } from "./Vsix";
const valid = require("../vendor/semver/functions/valid");
const compare = require("../vendor/semver/functions/compare");
const satisfies = require("../vendor/semver/functions/satisfies");
const validRange = require("../vendor/semver/ranges/valid");

export const RELEASE_REPOSITORY = "zlinkw/SimpleExperiment-Mac";
export const COMPONENT_IDS = ["simple-local.simple-sftp-mac", "simple-local.simple-experiment-mac"] as const;
export interface PreviewManifest {
  protocolVersion: 1;
  channel: "preview";
  publishedAt: string;
  releaseTag: string;
  components: ReleaseComponent[];
}
export interface PreviewPlan { manifest: PreviewManifest; pending: ReleaseComponent[]; releaseUrl: string }

export function parseManifest(value: any, release: any, vscodeVersion: string): PreviewManifest {
  if (value?.protocolVersion !== 1 || value?.channel !== "preview" || !/^preview-v\d+\.\d+\.\d+$/.test(value.releaseTag || "") || value.releaseTag !== release.tag_name
    || !Number.isFinite(Date.parse(value.publishedAt)) || !Array.isArray(value.components) || value.components.length !== 2) throw new Error("无效 preview 协议清单");
  const components: ReleaseComponent[] = [];
  for (const id of COMPONENT_IDS) {
    const candidates = value.components.filter((item: any) => item?.extensionId === id);
    if (candidates.length !== 1) throw new Error("配套组件身份缺失或重复");
    const item = candidates[0];
    const prefix = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${value.releaseTag}/`;
    const filename = `${id.split(".")[1]}-${item.version}-darwin-arm64.vsix`;
    const assets = (release.assets || []).filter((asset: any) => asset.name === filename && asset.browser_download_url === item.downloadUrl && asset.size === item.size);
    if (!valid(item.version) || !/^\d+\.\d+\.\d+$/.test(item.version) || !/^[0-9a-f]{40}$/.test(item.sourceCommit || "") || item.targetPlatform !== "darwin-arm64"
      || !validRange(item.vscodeEngine) || !satisfies(vscodeVersion, item.vscodeEngine)
      || !Number.isSafeInteger(item.size) || item.size < 22 || item.size > 128 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(item.sha256 || "")
      || item.downloadUrl !== prefix + filename || assets.length !== 1) throw new Error("preview 组件资产或兼容性校验失败");
    components.push({ extensionId: id, version: item.version, sourceCommit: item.sourceCommit, targetPlatform: item.targetPlatform, vscodeEngine: item.vscodeEngine, downloadUrl: item.downloadUrl, size: item.size, sha256: item.sha256 });
  }
  if (components[1].version !== value.releaseTag.slice("preview-v".length)) throw new Error("preview tag 与主组件版本不符");
  return { protocolVersion: 1, channel: "preview", publishedAt: value.publishedAt, releaseTag: value.releaseTag, components };
}

export function planPreview(manifest: PreviewManifest, installedVersion: (id: string) => string, releaseUrl = ""): PreviewPlan {
  return { manifest, releaseUrl, pending: manifest.components.filter(item => {
    const current = installedVersion(item.extensionId) || "0.0.0";
    if (!valid(current)) throw new Error("当前插件版本无法识别");
    return compare(item.version, current) > 0;
  }) };
}

interface CacheEntry { bytes: Buffer; etag: string; until: number }
export class PreviewReleaseClient {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<Buffer>>();
  private checking?: Promise<PreviewPlan>;
  private retryAt = 0;
  private failures = 0;
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}

  request(url: string, maxBytes: number, force = false): Promise<Buffer> {
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const cached = this.cache.get(url);
    if (!force && cached && cached.until > this.now()) return Promise.resolve(cached.bytes);
    if (this.retryAt > this.now()) return Promise.reject(new Error(`GitHub 限流，${new Date(this.retryAt).toISOString()} 后重试`));
    const promise = this.fetchBytes(url, maxBytes, cached).finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }
  private async fetchBytes(url: string, maxBytes: number, cached?: CacheEntry): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("GitHub 请求超时")), maxBytes > 4 * 1024 * 1024 ? 120000 : 20000);
    try {
      const response = await this.fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "SimpleExperiment-Mac", ...(cached?.etag ? { "If-None-Match": cached.etag } : {}) }, signal: controller.signal });
      if (response.status === 403 || response.status === 429) {
        this.failures++;
        const retry = response.headers.get("retry-after");
        const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now()) : 0;
        const resetMs = Number(response.headers.get("x-ratelimit-reset")) * 1000 - this.now();
        this.retryAt = this.now() + Math.min(24 * 3600000, Math.max(30000, retryMs || 0, Number.isFinite(resetMs) ? resetMs : 0, Math.min(1800000, 30000 * 2 ** Math.min(this.failures, 6))));
        throw new Error(`GitHub 检查失败：HTTP ${response.status}，进入退避`);
      }
      if (response.status === 304 && cached) { cached.until = this.now() + 300000; return cached.bytes; }
      if (!response.ok) throw new Error(`GitHub 检查失败：HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("GitHub 响应过大");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("GitHub 响应为空");
      const chunks: Buffer[] = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.byteLength;
          if (size > maxBytes) throw new Error("GitHub 响应超出上限");
          chunks.push(Buffer.from(item.value));
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      const bytes = Buffer.concat(chunks, size);
      this.failures = 0;
      // Package bytes are retained by the transaction, never in this query cache.
      if (maxBytes <= 4 * 1024 * 1024) {
        this.cache.set(url, { bytes, etag: response.headers.get("etag") || "", until: this.now() + 300000 });
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      }
      return bytes;
    } finally { clearTimeout(timer); }
  }
  check(vscodeVersion: string, installedVersion: (id: string) => string, manual = false): Promise<PreviewPlan> {
    if (this.checking) return this.checking;
    this.checking = this.checkReleases(vscodeVersion, installedVersion, manual).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async checkReleases(vscodeVersion: string, installedVersion: (id: string) => string, manual: boolean): Promise<PreviewPlan> {
    const validManifests: Array<{ manifest: PreviewManifest; release: any }> = [];
    let invalid = 0;
    // Releases are returned newest first. Bound API traffic and preserve a clear
    // failure if there is no compatible preview in the inspected 300 releases.
    for (let page = 1; page <= 3; page++) {
      const releases = JSON.parse((await this.request(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`, 4 * 1024 * 1024, manual)).toString("utf8"));
      if (!Array.isArray(releases)) throw new Error("GitHub Release 列表无效");
      for (const release of releases) {
        if (release.draft || release.prerelease !== true || !/^preview-v\d+\.\d+\.\d+$/.test(release.tag_name || "")) continue;
        const candidates = (release.assets || []).filter((asset: any) => asset.name === "release.json" && asset.browser_download_url === `https://github.com/${RELEASE_REPOSITORY}/releases/download/${release.tag_name}/release.json`);
        if (candidates.length !== 1) { invalid++; continue; }
        // Network errors must remain check failures; only malformed/incompatible
        // manifests are skipped while searching another preview.
        const bytes = await this.request(candidates[0].browser_download_url, 1024 * 1024, manual);
        try { validManifests.push({ manifest: parseManifest(JSON.parse(bytes.toString("utf8")), release, vscodeVersion), release }); }
        catch { invalid++; }
      }
      if (releases.length < 100) break;
    }
    if (!validManifests.length) throw new Error(`检查失败：没有有效兼容 preview${invalid ? `，拒绝 ${invalid} 个清单` : ""}`);
    validManifests.sort((a, b) => compare(b.manifest.components[1].version, a.manifest.components[1].version) || compare(b.manifest.components[0].version, a.manifest.components[0].version));
    const selected = validManifests[0];
    return planPreview(selected.manifest, installedVersion, `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${selected.manifest.releaseTag}`);
  }
  async download(component: ReleaseComponent, vscodeVersion: string): Promise<Buffer> {
    const bytes = await this.request(component.downloadUrl, Math.max(component.size, 4 * 1024 * 1024 + 1), true);
    verifyVsix(bytes, component, vscodeVersion);
    return bytes;
  }
}
