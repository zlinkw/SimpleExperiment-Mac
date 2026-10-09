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

function loadScopeDerivation() {
  const sandbox = {
    traceRowsForPlanScopeCache: new WeakMap(),
    planLookups: 0,
    planMatches: 0,
    meaningfulChecks: 0,
    asArray(value) {
      return Array.isArray(value) ? value : [];
    },
    normalizePlanSelectionKey(value) {
      return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    },
    planFromContext(state, context) {
      sandbox.planLookups += 1;
      return (state.plans || {})[context.planFile];
    },
    meaningfulValue(value) {
      sandbox.meaningfulChecks += 1;
      return String(value || "").trim();
    },
    samePlanSelection(left, right) {
      sandbox.planMatches += 1;
      return sandbox.normalizePlanSelectionKey(left).toLowerCase() === sandbox.normalizePlanSelectionKey(right).toLowerCase();
    },
    traceMatchesPlanVersion(row, revision, updatedAt) {
      if (revision && row.planRevision) return row.planRevision === revision;
      const rowAt = Date.parse(String(row.updatedAt || ""));
      return Number.isFinite(updatedAt) ? Number.isFinite(rowAt) && rowAt >= updatedAt : !revision;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("traceRowsForPlanScope")}\nthis.scopeRows = traceRowsForPlanScope;`, sandbox);
  return sandbox;
}

function fixture() {
  const rows = [
    { id: "a-current", planFile: "experiments/plans/a.yaml", planRevision: "r2", updatedAt: "2026-07-30T00:00:00Z" },
    { id: "a-old", planFile: "experiments/plans/a.yaml", planRevision: "r1", updatedAt: "2026-07-29T00:00:00Z" },
    { id: "unscoped", planFile: "", updatedAt: "2026-07-30T00:00:00Z" },
  ];
  const state = {
    planFileInput: "experiments/plans/a.yaml",
    plans: {
      "experiments/plans/a.yaml": { revision: "r2", updatedAt: "2026-07-30T00:00:00Z" },
    },
  };
  return { rows, state };
}

test("Plan trace scope reuses one derivation per rows, state, and mode", () => {
  const sandbox = loadScopeDerivation();
  const { rows, state } = fixture();
  assert.doesNotMatch(extractFunction("traceRowsForPlanScope"), /allRows\.filter\(/);
  const selected = sandbox.scopeRows(rows, state, "selected");
  const calls = { lookups: sandbox.planLookups, matches: sandbox.planMatches, meaningful: sandbox.meaningfulChecks };

  assert.strictEqual(sandbox.scopeRows(rows, state, "selected"), selected);
  assert.deepEqual({ lookups: sandbox.planLookups, matches: sandbox.planMatches, meaningful: sandbox.meaningfulChecks }, calls);
  assert.equal(sandbox.meaningfulChecks, rows.length);
  assert.deepEqual(Array.from(selected.rows, (row) => row.id), ["a-current"]);
  assert.equal(selected.scoped, true);
  assert.equal(selected.selectedCount, 1);
  assert.equal(selected.unscopedCount, 1);
  assert.equal(selected.totalCount, 3);

  const all = sandbox.scopeRows(rows, state, "all");
  assert.notStrictEqual(all, selected);
  assert.strictEqual(all.rows, rows);
  assert.equal(all.scoped, false);
  assert.equal(sandbox.meaningfulChecks, rows.length * 2);
});

test("Plan trace scope invalidates when rows or state objects are replaced", () => {
  const sandbox = loadScopeDerivation();
  const { rows, state } = fixture();
  const first = sandbox.scopeRows(rows, state, "selected");
  const replacedState = { ...state, plans: { ...state.plans } };
  const replacedRows = [...rows];

  assert.notStrictEqual(sandbox.scopeRows(rows, replacedState, "selected"), first);
  assert.notStrictEqual(sandbox.scopeRows(replacedRows, state, "selected"), first);

  const noPlanState = { selection: {}, plans: {} };
  const unscoped = sandbox.scopeRows(rows, noPlanState, "selected");
  assert.strictEqual(unscoped.rows, rows);
  assert.equal(unscoped.scoped, false);
  assert.equal(unscoped.selectedCount, 0);
});
