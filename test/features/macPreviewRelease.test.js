const test = require("node:test");
const assert = require("node:assert/strict");
const { PreviewReleaseClient, parseManifest, planPreview, COMPONENT_IDS } = require("../../dist/mac/PreviewRelease");

function release(version = "0.1.2") {
  const tag = `preview-v${version}`;
  const prefix = `https://github.com/zlinkw/SimpleExperiment-Mac/releases/download/${tag}/`;
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: "2026-10-09T12:00:00Z", components: COMPONENT_IDS.map(extensionId => ({ extensionId, version, sourceCommit: "a".repeat(40), targetPlatform: "darwin-arm64", vscodeEngine: "^1.100.0", downloadUrl: prefix + `${extensionId.split(".")[1]}-${version}-darwin-arm64.vsix`, size: 100, sha256: "b".repeat(64) })) };
  const info = { tag_name: tag, prerelease: true, draft: false, assets: [{ name: "release.json", browser_download_url: prefix + "release.json", size: 1000 }, ...manifest.components.map(item => ({ name: item.downloadUrl.split("/").at(-1), browser_download_url: item.downloadUrl, size: item.size }))] };
  return { manifest, info };
}
test("anonymous releases list filters stable/draft/invalid previews and sorts semantic versions", async () => {
  const old = release("0.1.9"), current = release("0.1.10"), broken = release("0.1.11"); broken.manifest.components[0].targetPlatform = "win32-arm64";
  const calls = [];
  const client = new PreviewReleaseClient(async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, undefined); assert.ok(!url.includes("/latest"));
    if (url.includes("?per_page")) return Response.json([{ ...release("9.0.0").info, prerelease: false }, { ...release("8.0.0").info, draft: true }, old.info, broken.info, current.info]);
    return Response.json([old, broken, current].find(item => item.info.assets[0].browser_download_url === url).manifest);
  });
  const result = await client.check("1.100.0", () => "0.1.1");
  assert.equal(result.manifest.releaseTag, "preview-v0.1.10"); assert.equal(result.pending.length, 2);
  await client.check("1.100.0", () => "0.1.10"); assert.equal(calls.length, 4);
});
test("same versions and newer installed versions skip without downgrading", () => {
  const { manifest } = release();
  assert.equal(planPreview(manifest, () => "0.1.2").pending.length, 0);
  assert.equal(planPreview(manifest, () => "0.2.0").pending.length, 0);
  assert.deepEqual(planPreview(manifest, id => id === COMPONENT_IDS[0] ? "0.1.2" : "0.1.1").pending.map(item => item.extensionId), [COMPONENT_IDS[1]]);
});
test("rejects forged assets, duplicate components, malformed commits, protocol and incompatible VS Code", () => {
  for (const mutate of [m => m.protocolVersion = 2, m => m.components[0].sourceCommit = "bad", m => m.components[0].downloadUrl = "https://evil.test/package.vsix", m => m.components[0] = m.components[1]]) {
    const { manifest, info } = release(); mutate(manifest); assert.throws(() => parseManifest(manifest, info, "1.100.0"));
  }
  const { manifest, info } = release(); assert.throws(() => parseManifest(manifest, info, "1.99.0"));
});
test("duplicate requests coalesce and ETag caching revalidates manual checks", async () => {
  let count = 0, resume; const gate = new Promise(resolve => { resume = resolve; });
  const client = new PreviewReleaseClient(async (url, options) => {
    count++; await gate;
    return options.headers["If-None-Match"] ? new Response(null, { status: 304 }) : new Response("valid", { headers: { etag: '"test"' } });
  });
  const first = client.request("https://test", 100), second = client.request("https://test", 100);
  assert.equal(first, second); resume(); assert.equal((await first).toString(), "valid");
  await client.request("https://test", 100); assert.equal(count, 1);
  await client.request("https://test", 100, true); assert.equal(count, 2);
});
test("403 and 429 back off; unreachable, malformed and empty releases stay failures", async () => {
  for (const status of [403, 429]) {
    let count = 0, now = 0;
    const client = new PreviewReleaseClient(async () => { count++; return new Response("limited", { status, headers: { "retry-after": "120" } }); }, () => now);
    await assert.rejects(client.check("1.100.0", () => "0.1.1"), /检查失败/);
    await assert.rejects(client.check("1.100.0", () => "0.1.1"), /限流/); assert.equal(count, 1);
    now = 121000; await assert.rejects(client.check("1.100.0", () => "0.1.1")); assert.equal(count, 2);
  }
  for (const fetcher of [async () => { throw Error("offline"); }, async () => new Response("broken"), async () => Response.json([])]) {
    const client = new PreviewReleaseClient(fetcher); await assert.rejects(client.check("1.100.0", () => "0.1.1"));
  }
});
test("oversize responses are refused even without content-length", async () => {
  const client = new PreviewReleaseClient(async () => new Response("oversize"));
  await assert.rejects(client.request("https://test", 3), /上限/);
});
