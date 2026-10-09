const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("result mapping opens in the result area with column examples and optional fields", () => {
  const html = renderPanelHtml();
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    .find((candidate) => candidate.includes("function renderResultColumnMappingEditor(")) || "";
  const start = script.indexOf("function renderResultColumnMappingEditor(");
  const end = script.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const context = {
    asArray: (value) => Array.isArray(value) ? value : [],
    configDraftValue: (_scope, _field, fallback) => fallback,
    detailsOpenAttr: () => "",
    esc: (value) => String(value),
    escAttr: (value) => String(value),
  };
  vm.runInNewContext(script.slice(start, end), context);
  const rendered = context.renderResultColumnMappingEditor(
    { resultOutputConfig: { columnMapping: { case: "specimen" } } },
    { source: "experiments/results/raw.csv", headers: ["specimen", "rng", "accuracy"], mapping: { case: "specimen", seed: "rng" }, sampleValues: { specimen: ["alpha", "beta"], rng: ["42"], accuracy: ["0.9"] }, metricColumns: [{ column: "accuracy", metric: "accuracy" }] },
  );
  assert.match(rendered, /id="resultColumnMappingEditor"/);
  assert.match(rendered, /data-key="case"/);
  assert.match(rendered, /data-key="seed"/);
  assert.match(rendered, /data-key="metric"/);
  assert.match(rendered, /data-key="value"/);
  assert.match(rendered, /样例：alpha \/ beta/);
  assert.match(rendered, /其他字段：数据集、方法、比例、评估端点/);
  assert.match(rendered, /<select data-config-input="resultMapping"/);
  assert.match(rendered, /保存映射/);
  assert.doesNotMatch(rendered, /<input list=/);
});
