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
  await client.check("1.100.0", () => "0.1.10"); assert.equal(calls.length, 3);
  assert.ok(!calls.includes(old.info.assets[0].browser_download_url));
});
test("valid newest preview does not request unreadable older manifests, including manual checks", async () => {
  const latest = release("0.1.20"), old = release("0.1.19"), calls = [];
  const client = new PreviewReleaseClient(async url => {
    calls.push(url);
    if (url.includes("?per_page")) return Response.json([old.info, latest.info, null, { ...old.info, tag_name: "preview-v00.1.19" }]);
    if (url === latest.info.assets[0].browser_download_url) return Response.json(latest.manifest);
    throw Error("old manifest is offline");
  });
  for (const manual of [false, true]) assert.equal((await client.check("1.100.0", () => "0.1.1", manual)).manifest.releaseTag, latest.manifest.releaseTag);
  assert.equal(calls.length, 4);
  assert.ok(!calls.includes(old.info.assets[0].browser_download_url));
});
test("semantic newest on later metadata page beats publication order", async () => {
  const older = release("0.1.9"), newer = release("0.1.10"), calls = [];
  const client = new PreviewReleaseClient(async url => {
    calls.push(url);
    if (url.endsWith("page=1")) return Response.json([older.info, ...Array.from({ length: 99 }, () => ({ prerelease: false }))]);
    if (url.endsWith("page=2")) return Response.json([newer.info]);
    assert.equal(url, newer.info.assets[0].browser_download_url);
    return Response.json(newer.manifest);
  });
  assert.equal((await client.check("1.100.0", () => "0.1.1")).manifest.releaseTag, newer.manifest.releaseTag);
  assert.equal(calls.length, 3);
});
test("higher preview transport failure cannot fall back to an older version", async () => {
  for (const failure of [async () => { throw Error("offline"); }, async () => new Response("unavailable", { status: 503 })]) {
    const older = release("0.1.9"), newer = release("0.1.10"), calls = [];
    const client = new PreviewReleaseClient(async url => {
      calls.push(url);
      if (url.includes("?per_page")) return Response.json([older.info, newer.info]);
      assert.equal(url, newer.info.assets[0].browser_download_url);
      return failure();
    });
    await assert.rejects(client.check("1.100.0", () => "0.1.1"), /offline|检查失败/);
    assert.equal(calls.length, 2);
  }
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
test("ordinary 403 with nonzero quota or no rate evidence permits another manual check", async () => {
  for (const headers of [{ "x-ratelimit-remaining": "59", "x-ratelimit-reset": "3600" }, {}, { "retry-after": "invalid" }]) {
    let count = 0; const latest = release("0.1.20");
    const client = new PreviewReleaseClient(async url => {
      count++;
      if (count === 1) return new Response("Forbidden", { status: 403, headers });
      return Response.json(url.includes("?per_page") ? [latest.info] : latest.manifest);
    }, () => 0);
    await assert.rejects(client.check("1.100.0", () => "0.1.1", true), /HTTP 403/);
    assert.equal((await client.check("1.100.0", () => "0.1.1", true)).manifest.releaseTag, latest.manifest.releaseTag);
    assert.equal(count, 3);
  }
});
test("secondary 403 and 429 with nonzero quota ignore the primary one-hour reset", async () => {
  for (const status of [403, 429]) {
    let count = 0, now = 0; const latest = release("0.1.20");
    const client = new PreviewReleaseClient(async url => {
      count++;
      if (count === 1) return Response.json({ message: "You have exceeded a secondary rate limit." }, {
        status, headers: { "x-ratelimit-remaining": "59", "x-ratelimit-reset": "3600" } });
      return Response.json(url.includes("?per_page") ? [latest.info] : latest.manifest);
    }, () => now);
    await assert.rejects(client.check("1.100.0", () => "0.1.1", true), /HTTP/);
    now = 59000; await assert.rejects(client.check("1.100.0", () => "0.1.1", true), /限流/); assert.equal(count, 1);
    now = 61000; assert.equal((await client.check("1.100.0", () => "0.1.1", true)).pending.length, 2);
    assert.equal(count, 3);
  }
});
test("confirmed zero-quota primary limit and explicit Retry-After are respected", async () => {
  for (const headers of [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, { "retry-after": "Thu, 01 Jan 1970 01:00:00 GMT" }]) {
    let count = 0, now = 0; const client = new PreviewReleaseClient(async () => {
      count++; return new Response("limited", { status: 403, headers });
    }, () => now);
    await assert.rejects(client.check("1.100.0", () => "0.1.1", true));
    now = 3599000; await assert.rejects(client.check("1.100.0", () => "0.1.1", true), /限流/); assert.equal(count, 1);
    now = 3601000; await assert.rejects(client.check("1.100.0", () => "0.1.1", true), /HTTP 403/); assert.equal(count, 2);
  }
});
test("oversized denial body is cancelled, does not leak text and does not establish a rate limit", async () => {
  let count = 0, cancelled = false; const latest = release("0.1.20");
  const client = new PreviewReleaseClient(async url => {
    count++;
    if (count === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("password=secret".repeat(3000))); },
      cancel() { cancelled = true; },
    }), { status: 403 });
    return Response.json(url.includes("?per_page") ? [latest.info] : latest.manifest);
  }, () => 0);
  await assert.rejects(client.check("1.100.0", () => "0.1.1", true), error => {
    assert.match(error.message, /HTTP 403.*api.github.com/); assert.doesNotMatch(error.message, /password|secret/); return true;
  });
  assert.equal(cancelled, true);
  assert.equal((await client.check("1.100.0", () => "0.1.1", true)).pending.length, 2);
});
