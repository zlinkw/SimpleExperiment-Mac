const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadStatusText() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("gpuStatusText")}\nthis.statusText = gpuStatusText;`, sandbox);
  return sandbox.statusText;
}

function loadFreshness() {
  const sandbox = {
    hasText: (value) => Boolean(String(value === undefined || value === null ? "" : value).trim()) && String(value).trim() !== "-",
    relativeTimestampView: (value, label) => ({ label, raw: String(value || "-"), relative: "relative:" + String(value || "-") }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("gpuServerFreshnessView")}\nthis.freshness = gpuServerFreshnessView;`, sandbox);
  return sandbox.freshness;
}

const NO_FLAGS = { highMemory: false, highLoad: false };
const NOT_MINE = { isMine: false, shared: false };

test("stale GPU readings are labelled instead of reading as authoritative", () => {
  const statusText = loadStatusText();
  assert.equal(statusText({ busy: false }, NOT_MINE, NO_FLAGS), "空闲");
  assert.equal(statusText({ busy: false, staleFromCache: true }, NOT_MINE, NO_FLAGS), "空闲 · 数据陈旧");
  assert.equal(statusText({ busy: true, staleFromCache: true }, NOT_MINE, NO_FLAGS), "占用 · 数据陈旧");
  assert.equal(statusText({ busy: true, staleFromCache: true }, { isMine: true, shared: true }, { highMemory: true, highLoad: true }), "我在用 · 共享 · 高显存 · 高负载 · 数据陈旧");
});

test("fresh GPU readings keep the original status wording", () => {
  const statusText = loadStatusText();
  assert.equal(statusText({ busy: true }, NOT_MINE, { highMemory: true, highLoad: false }), "占用 · 高显存");
  assert.equal(statusText({ busy: false }, { isMine: true, shared: false }, NO_FLAGS), "我在用");
  assert.equal(statusText({}, NOT_MINE, NO_FLAGS), "空闲");
});

test("GPU server head carries snapshot age next to the status", () => {
  const freshness = loadFreshness();
  const fresh = freshness({ updatedAt: "2026-07-26T10:00:00Z" });
  assert.equal(fresh.label, "relative:2026-07-26T10:00:00Z");
  assert.equal(fresh.title, "更新时间：2026-07-26T10:00:00Z");

  const stale = freshness({ updatedAt: "2026-07-26T09:00:00Z", staleFromCache: true });
  assert.match(stale.title, /沿用上次数据$/);

  const fallback = freshness({ updatedAt: "-", uiReceivedAt: "2026-07-26T11:00:00Z" });
  assert.equal(fallback.label, "relative:2026-07-26T11:00:00Z");

  for (const server of [{}, null, undefined, { updatedAt: "-", uiReceivedAt: "" }, { updatedAt: "-", uiReceivedAt: "-" }]) {
    const empty = freshness(server);
    assert.equal(empty.label, "", "no timestamp must not render a freshness pill");
    assert.equal(empty.title, "");
  }
});

test("stale rows and cards get distinguishable markup", () => {
  const rowRenderer = extractFunction("renderGpuRow");
  assert.match(rowRenderer, /if \(gpu\.staleFromCache\) klass\.push\("is-stale"\)/);
  assert.match(rowRenderer, /\(gpu\.staleFromCache \? " stale" : ""\)/);
  assert.match(panelSource, /\.gpu-row\.is-stale \{/);
  assert.match(panelSource, /\.metric-value\.statusValue\.stale \{/);
  assert.match(panelSource, /\.pill\.gpuServerFreshness\.stale \{/);
  assert.match(panelSource, /gpuServerStatusGroup/);
});
