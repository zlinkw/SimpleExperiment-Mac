const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

function renderPanelHtmlFromSource(source) {
  return require("../../dist/ui/PanelHtml.js").renderPanelHtml();
}

function extractScripts(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) scripts.push(match[1]);
  assert.ok(scripts.length > 0, "script tag missing");
  return scripts;
}

function loadRenderedPanelScript() {
  const source = readSource("src/ui/PanelHtml.ts");
  return extractScripts(renderPanelHtmlFromSource(source)).find((script) => script.includes("function isParseableResultCandidate")) || "";
}

test("panel and extension output gates share nextStep and parseable candidate regex", () => {
  const extension = readSource("src/extension.ts");
  const panel = readSource("src/ui/PanelHtml.ts");
  const script = loadRenderedPanelScript();
  assert.match(extension, /nextStep/);
  for (const source of [extension, panel]) {
    assert.match(source, /计划强契约/);
    assert.match(source, /下一步/);
  }
  assert.doesNotThrow(() => new vm.Script(script, { filename: "panel-webview.js" }));
  assert.match(script, /isParseableResultCandidate/);
  assert.match(script, /jobs\.csv/);
  assert.match(script, /csv\|json\|txt\|log\|out/);
  // 当前面板将结果位置与门禁下一步分开展示。
  assert.match(extension, /nextLabel: next \? next\.label : ""/);
  assert.match(extension, /nextStep: next \? \(next\.fix \|\| ""\) : ""/);
  assert.match(extension, /在 experiments\/plans 下创建或放入 YAML Plan/);
});

test("isParseableResultCandidate accepts nested plan result paths", () => {
  const script = loadRenderedPanelScript();
  const match = script.match(/function isParseableResultCandidate\(value\) \{[\s\S]*?\n    \}/);
  const metadata = script.match(/const RESULT_METADATA_FILENAMES = new Set\([^;]+;\s+const RESULT_METADATA_SUFFIXES = \[[^\]]*\];/);
  assert.ok(match, "rendered helper missing");
  assert.ok(metadata, "result metadata constants missing");
  const fn = new Function(metadata[0] + match[0] + "; return isParseableResultCandidate;")();
  assert.equal(fn("work_dirs/smoke/metrics_summary.csv"), true);
  assert.equal(fn("experiments/results/suite_a/result.json"), true);
  assert.equal(fn("jobs.csv"), false);
  assert.equal(fn("path/to/jobs.csv"), false);
  assert.equal(fn("readme.md"), false);
});
