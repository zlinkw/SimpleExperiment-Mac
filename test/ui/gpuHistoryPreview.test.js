const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { buildPreviewState, renderPreviewHtml } = require("../../scripts/render-gpu-history-preview.js");

test("GPU history preview provides deterministic multi-server visual data", () => {
  const state = buildPreviewState();
  assert.equal(Object.keys(state.gpu).length, 4);
  assert.equal(state.gpuHistory.status, "ready");
  assert.equal(state.gpuHistory.data.series.length, 8);
  assert.ok(state.gpuHistory.data.series.some((series) => series.points.some((point) => point.gapBefore === true)));
});

test("GPU history preview replaces VS Code APIs and keeps inline scripts valid", () => {
  const html = renderPreviewHtml();
  assert.doesNotMatch(html, /acquireVsCodeApi\(\)/);
  assert.match(html, /data-preview-theme/);
  assert.match(html, /data-preview-bootstrap/);
  assert.match(html, /details\[data-gpu-history-scope="overview"\]/);
  assert.match(html, /details\[data-gpu-history-scope="gpu"\]/);

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 2);
  scripts.forEach((source) => new vm.Script(source));
});
