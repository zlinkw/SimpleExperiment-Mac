const assert = require("node:assert/strict");
const test = require("node:test");
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
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1;
    if (script[index] === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error("unclosed inline function " + name);
}

function loadCompactor() {
  const context = {
    compactPathCache: new Map(),
    COMPACT_PATH_CACHE_LIMIT: 256,
  };
  vm.createContext(context);
  vm.runInContext([inlineFunction("compactText"), inlineFunction("compactPath"), "this.compactPath = compactPath;"].join("\n"), context);
  return context;
}

test("path compaction cache reuses Windows and POSIX paths with a fixed bound", () => {
  const context = loadCompactor();
  const windowsPath = "C:\\projects\\demo\\experiments\\plan.yaml";
  assert.equal(context.compactPath(windowsPath), "…/experiments/plan.yaml");
  assert.equal(context.compactPath("/srv/projects/demo/results.csv"), "…/demo/results.csv");
  assert.equal(context.compactPathCache.size, 2);
  context.compactPath(windowsPath);
  for (let index = 0; index < 300; index += 1) context.compactPath("/srv/run/" + index + "/result.json");
  assert.equal(context.compactPathCache.size, context.COMPACT_PATH_CACHE_LIMIT);
});
