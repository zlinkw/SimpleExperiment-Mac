const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

function inlineFunction(name) {
  const html = renderPanelHtml();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((candidate) => candidate.includes("function " + name + "(")) || "";
  const start = script.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "missing inline function " + name);
  const bodyStart = script.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unclosed inline function " + name);
}

test("config inspector classifies selected values against the current Plan config", () => {
  const context = {
    configParamDiffBaseCache: new WeakMap(),
    EMPTY_CONFIG_PARAM_DIFF_SOURCE: Object.freeze({}),
    asArray(value) { return Array.isArray(value) ? value : []; },
    naturalCompare(left, right) { return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }); },
  };
  vm.runInNewContext([inlineFunction("configParamsByKey"), inlineFunction("configParamDiffBase"), inlineFunction("configParamDiffRows")].join("\n"), context);
  const baseline = { file: "configs/base.yaml", params: [
    { key: "model.depth", value: "18", kind: "scalar" },
    { key: "seed", value: "7", kind: "scalar" },
    { key: "trainer.epochs", value: "10", kind: "scalar" },
  ] };
  const selected = { file: "configs/large.yaml", params: [
    { key: "model.depth", value: "50", kind: "scalar" },
    { key: "optimizer.lr", value: "0.001", kind: "scalar" },
    { key: "seed", value: "7", kind: "scalar" },
  ] };
  const diff = context.configParamDiffRows(selected, baseline, "");
  assert.deepEqual({ ...diff.counts }, { same: 1, changed: 1, added: 1, missing: 1, uncertain: 0 });
  assert.deepEqual(Array.from(diff.rows, (row) => [row.key, row.kind]), [
    ["model.depth", "changed"],
    ["optimizer.lr", "added"],
    ["seed", "same"],
    ["trainer.epochs", "missing"],
  ]);
  assert.deepEqual(Array.from(context.configParamDiffRows(selected, baseline, "10").rows, (row) => row.key), ["trainer.epochs"]);
  assert.deepEqual(Array.from(context.configParamDiffRows(undefined, baseline, "").rows), []);
  const truncated = context.configParamDiffRows({ ...selected, omittedParamCount: 5 }, baseline, "");
  assert.equal(truncated.rows.find((row) => row.key === "trainer.epochs").kind, "uncertain");
  assert.equal(truncated.counts.missing, 0);
  assert.equal(truncated.counts.uncertain, 1);
});

test("config inspector reuses structural diffs while keeping each search current", () => {
  const context = {
    configParamDiffBaseCache: new WeakMap(),
    EMPTY_CONFIG_PARAM_DIFF_SOURCE: Object.freeze({}),
    asArray(value) { return Array.isArray(value) ? value : []; },
    naturalCompare(left, right) { return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }); },
  };
  vm.runInNewContext([inlineFunction("configParamsByKey"), inlineFunction("configParamDiffBase"), inlineFunction("configParamDiffRows")].join("\n"), context);
  const selected = { file: "configs/large.yaml", params: [
    { key: "model.depth", value: "50", kind: "scalar" },
    { key: "optimizer.lr", value: "0.001", kind: "scalar" },
  ] };
  const baseline = { file: "configs/base.yaml", params: [
    { key: "model.depth", value: "18", kind: "scalar" },
    { key: "trainer.epochs", value: "10", kind: "scalar" },
  ] };

  const first = context.configParamDiffRows(selected, baseline, "");
  assert.equal(context.configParamDiffRows(selected, baseline, ""), first);
  assert.deepEqual(Array.from(context.configParamDiffRows(selected, baseline, "optimizer").rows, (row) => row.key), ["optimizer.lr"]);
  assert.deepEqual(Array.from(context.configParamDiffRows(selected, baseline, "trainer").rows, (row) => row.key), ["trainer.epochs"]);
  assert.equal(context.configParamDiffRows(selected, { ...baseline, params: [...baseline.params] }, "") === first, false);
  assert.equal(context.configParamDiffRows({ ...selected, params: [...selected.params] }, baseline, "") === first, false);
});

test("config inspector indexes params in one traversal with last duplicate winning", () => {
  const context = { asArray(value) { return Array.isArray(value) ? value : []; } };
  const source = inlineFunction("configParamsByKey");
  assert.doesNotMatch(source, /\.map\(|\.filter\(/);
  vm.runInNewContext(source, context);
  const first = { key: "seed", value: "1" };
  const last = { key: "seed", value: "2" };
  const indexed = context.configParamsByKey([first, { key: "", value: "ignored" }, null, last]);
  assert.deepEqual(Array.from(indexed.keys()), ["seed"]);
  assert.equal(indexed.get("seed"), last);
  assert.equal(context.configParamsByKey(undefined).size, 0);
});

test("config inspector accepts only concrete Plan config files as a comparison baseline", () => {
  const context = {};
  vm.runInNewContext(inlineFunction("configInspectorPlanConfigFile"), context);
  assert.equal(context.configInspectorPlanConfigFile({ baseConfig: "configs/base.yaml" }), "configs/base.yaml");
  assert.equal(context.configInspectorPlanConfigFile({ baseConfig: "'configs/base.json'" }), "configs/base.json");
  assert.equal(context.configInspectorPlanConfigFile({ configSource: "Plan 内联配置" }), "");
  assert.equal(context.configInspectorPlanConfigFile({ baseConfig: "" }), "");
});

test("config inspector preview details removed from panel", () => {
  const html = renderPanelHtml();
  assert.doesNotMatch(html, /配置参数预览/);
  assert.doesNotMatch(html, /Plan 基准：/);
  assert.doesNotMatch(html, /一致 ' \+ diff\.counts\.same/);
  assert.doesNotMatch(html, /变更 ' \+ diff\.counts\.changed/);
  assert.doesNotMatch(html, /仅所选 ' \+ diff\.counts\.added/);
  assert.doesNotMatch(html, /所选缺少 ' \+ diff\.counts\.missing/);
  assert.doesNotMatch(html, /摘要外待确认 ' \+ diff\.counts\.uncertain/);
  assert.doesNotMatch(html, /当前 Plan 使用内联、case 级配置或未声明配置/);
  assert.doesNotMatch(html, /cfg\.searchText\.includes\(query\)/);
  assert.match(html, /function configParamDiffRows\(selected, baseline, query\)/);
  assert.match(html, /所选配置：.*Plan 配置：/);
});
