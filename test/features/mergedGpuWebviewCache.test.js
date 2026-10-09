const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadCache() {
  const sandbox = {
    EMPTY_GPU_FOR_WEBVIEW_SOURCE: Object.freeze({}),
    mergedGpuForWebviewCache: null,
    mergeCalls: 0,
    compactCalls: 0,
    mergeFallbackRecords(...values) {
      sandbox.mergeCalls += 1;
      return Object.assign({}, ...values);
    },
    compactGpuForWebview(value) {
      sandbox.compactCalls += 1;
      return { ...value };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("compactMergedGpuForWebview")}\nthis.compactMergedGpu = compactMergedGpuForWebview;`, sandbox);
  return sandbox;
}

test("merged GPU Webview cache reuses stable three-source snapshots", () => {
  const sandbox = loadCache();
  const offline = { offline: { value: 1 } };
  const snapshot = { snapshot: { value: 2 } };
  const realtime = { realtime: { value: 3 } };
  const first = sandbox.compactMergedGpu(offline, snapshot, realtime);
  const calls = { merge: sandbox.mergeCalls, compact: sandbox.compactCalls };

  assert.strictEqual(sandbox.compactMergedGpu(offline, snapshot, realtime), first);
  assert.deepEqual({ merge: sandbox.mergeCalls, compact: sandbox.compactCalls }, calls);
});

test("merged GPU Webview cache invalidates when any source object is replaced", () => {
  const sandbox = loadCache();
  const offline = { serverA: { source: "offline" } };
  const snapshot = { serverB: { source: "snapshot" } };
  const realtime = { serverC: { source: "realtime" } };
  const first = sandbox.compactMergedGpu(offline, snapshot, realtime);

  assert.notStrictEqual(sandbox.compactMergedGpu({ ...offline }, snapshot, realtime), first);
  const second = sandbox.compactMergedGpu(offline, snapshot, realtime);
  assert.notStrictEqual(sandbox.compactMergedGpu(offline, { ...snapshot }, realtime), second);
  const third = sandbox.compactMergedGpu(offline, snapshot, realtime);
  assert.notStrictEqual(sandbox.compactMergedGpu(offline, snapshot, { ...realtime }), third);
});

test("merged GPU Webview cache preserves offline, snapshot, realtime precedence", () => {
  const sandbox = loadCache();
  const compacted = sandbox.compactMergedGpu(
    { serverA: { source: "offline" }, serverB: { source: "offline" } },
    { serverB: { source: "snapshot" }, serverC: { source: "snapshot" } },
    { serverC: { source: "realtime" }, serverD: { source: "realtime" } },
  );

  assert.equal(compacted.serverA.source, "offline");
  assert.equal(compacted.serverB.source, "snapshot");
  assert.equal(compacted.serverC.source, "realtime");
  assert.equal(compacted.serverD.source, "realtime");
});

test("empty GPU sources share one merged Webview result", () => {
  const sandbox = loadCache();
  const first = sandbox.compactMergedGpu(undefined, null, "");

  assert.deepEqual(first, {});
  assert.strictEqual(sandbox.compactMergedGpu(undefined, null, ""), first);
  assert.equal(sandbox.mergeCalls, 1);
  assert.equal(sandbox.compactCalls, 1);
});
