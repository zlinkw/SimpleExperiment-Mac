const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadSummaries() {
  const sandbox = {
    planTaskScaleSummaryCache: new WeakMap(),
    validResultPreviewCountCache: new WeakMap(),
    asArray(value) {
      return Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("planTaskScaleSummary"),
    extractFunction("resultPreviewHasRecords"),
    extractFunction("validResultPreviewCount"),
    "this.scale = planTaskScaleSummary;",
    "this.previewCount = validResultPreviewCount;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("Plan task scale summary reuses stable plans and preserves mismatch text", () => {
  const sandbox = loadSummaries();
  let reads = 0;
  const plan = {};
  Object.defineProperties(plan, {
    cases: { enumerable: true, get() { reads += 1; return [{ id: "a" }, { id: "b" }]; } },
    seeds: { enumerable: true, get() { reads += 1; return [1, 2, 3]; } },
    jobCount: { enumerable: true, get() { reads += 1; return 5; } },
  });

  const first = sandbox.scale(plan);
  assert.equal(first, "2 个实验项 × 3 个随机种子 = 6 个任务（记录 5 个任务，校验为准）");
  assert.equal(reads, 3);
  assert.equal(sandbox.scale(plan), first);
  assert.equal(reads, 3);
  assert.equal(sandbox.planTaskScaleSummaryCache.has(plan), true);

  const replacement = { cases: [{ id: "a" }], seeds: [1, 2], jobCount: 2 };
  assert.equal(sandbox.scale(replacement), "1 个实验项 × 2 个随机种子 = 2 个任务");
  const incomplete = { jobCount: 4 };
  assert.equal(sandbox.scale(incomplete), "4 个任务（实验项/随机种子待校验）");
  const empty = {};
  assert.equal(sandbox.scale(empty), "任务规模待校验");
  assert.equal(sandbox.planTaskScaleSummaryCache.has(empty), true);
});

test("parseable result preview count caches arrays, object maps, and zero results", () => {
  const sandbox = loadSummaries();
  let reads = 0;
  const valid = {};
  Object.defineProperties(valid, {
    parseable: { enumerable: true, get() { reads += 1; return true; } },
    records: { enumerable: true, get() { reads += 1; return 2; } },
  });
  const previews = [valid, { parseable: true, rows: 0 }, { parseable: false, records: 8 }];

  assert.equal(sandbox.previewCount(previews), 1);
  assert.equal(reads, 2);
  assert.equal(sandbox.previewCount(previews), 1);
  assert.equal(reads, 2);
  assert.equal(sandbox.validResultPreviewCountCache.has(previews), true);

  const mapped = { a: { parseable: true, rowCount: 1 }, b: { parseable: true, recordCount: 0 } };
  assert.equal(sandbox.previewCount(mapped), 1);
  const empty = [];
  assert.equal(sandbox.previewCount(empty), 0);
  assert.equal(sandbox.previewCount(empty), 0);
  assert.equal(sandbox.validResultPreviewCountCache.has(empty), true);
  assert.equal(sandbox.previewCount([...previews, { parseable: true, records: 1 }]), 2);
  assert.equal(sandbox.previewCount(null), 0);

  assert.match(panel, /const planTaskScaleSummaryCache = new WeakMap\(\)/);
  assert.match(panel, /const validResultPreviewCountCache = new WeakMap\(\)/);
});
