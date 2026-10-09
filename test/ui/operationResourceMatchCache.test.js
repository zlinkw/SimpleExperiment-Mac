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
    if (depth === 0) return panel.slice(start, index + 1).replace(/\\\\/g, "\\");
  }
  throw new Error(`unterminated ${name}`);
}

const INFRASTRUCTURE_PATTERN = /self|debug|audit|diagnostic|agent|tunnel|port/;

function loadMatcher() {
  const sandbox = {
    MATCH_EVERY_OPERATION: () => true,
    MATCH_NO_OPERATION: () => false,
    OPERATION_SECTION_MATCH_PATTERNS: new Map([
      ["sync", /publish|github|upload|deploy|sftp|sync|distribute/],
      ["tasks", /stop|retry|archive|delete|worker|task|experiment|run/],
      ["results", /parse|result|quality|statistics|paper|claim|archive|sync/],
      ["plans", /plan|validate|dry-run|run-plan|reproduce/],
      ["servers", INFRASTRUCTURE_PATTERN],
      ["diagnostics", INFRASTRUCTURE_PATTERN],
    ]),
    operationSearchHaystackCache: new WeakMap(),
    asArray: (value) => (Array.isArray(value) ? value : []),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("firstMatchingOperationRows"),
    extractFunction("operationSearchHaystack"),
    extractFunction("operationResourceMatcher"),
    extractFunction("operationMatchesResource"),
    "this.firstMatching = firstMatchingOperationRows;",
    "this.haystack = operationSearchHaystack;",
    "this.matcher = operationResourceMatcher;",
    "this.matches = operationMatchesResource;",
  ].join("\n"), sandbox);
  return sandbox;
}

function matchedIds(sandbox, rows, meta, section, limit = 4) {
  return sandbox.firstMatching(rows, meta, section, limit).map((row) => row.operationId).join(",");
}

function countingRow(fields) {
  let reads = 0;
  const row = {};
  Object.keys(fields).forEach((key) => {
    Object.defineProperty(row, key, {
      enumerable: true,
      get() { reads += 1; return fields[key]; },
    });
  });
  return { row, reads: () => reads };
}

test("operation haystacks are derived once per row object", () => {
  const sandbox = loadMatcher();
  const source = countingRow({ operationId: "op-1", type: "run-plan", status: "running", message: "提交 Plan" });

  const first = sandbox.haystack(source.row);
  const readsAfterFirst = source.reads();
  assert.match(first, /op-1 .*run-plan/);
  assert.equal(sandbox.haystack(source.row), first);
  assert.equal(source.reads(), readsAfterFirst);
  assert.equal(sandbox.haystack(null), "");
  assert.equal(sandbox.haystack("not-a-row"), "");
});

test("section matchers keep the documented anchor-free scoping", () => {
  const sandbox = loadMatcher();
  const rows = [
    { operationId: "op-run", type: "run-plan", status: "running" },
    { operationId: "op-sync", type: "sync-artifacts", status: "completed" },
    { operationId: "op-self", type: "self-check", status: "completed" },
  ];

  assert.equal(matchedIds(sandbox, rows, {}, "operations"), "op-run,op-sync,op-self");
  assert.equal(matchedIds(sandbox, rows, {}, "plans"), "op-run");
  assert.equal(matchedIds(sandbox, rows, {}, "sync"), "op-sync");
  assert.equal(matchedIds(sandbox, rows, {}, "diagnostics"), "op-self");
  assert.equal(matchedIds(sandbox, rows, {}, "gpu"), "");
  assert.equal(matchedIds(sandbox, rows, { anchor: "unknown-anchor" }, "gpu"), "");
});

test("anchored matchers reuse one token list for the whole row scan", () => {
  const sandbox = loadMatcher();
  const rows = [
    { operationId: "op-1", type: "archive-artifacts", message: "归档 worker-a" },
    { operationId: "op-2", type: "delete-artifacts", message: "清理 worker-b" },
  ];
  const meta = { anchor: "tasks-worker-a", label: "worker-a" };

  assert.equal(matchedIds(sandbox, rows, meta, "tasks"), "op-1");
  assert.equal(sandbox.matches(rows[0], meta, "tasks"), true);
  assert.equal(sandbox.matches(rows[1], meta, "tasks"), false);
});

test("first matching honours the requested limit and defaults", () => {
  const sandbox = loadMatcher();
  const rows = Array.from({ length: 12 }, (unused, index) => ({ operationId: "op-" + index, type: "run-plan" }));

  assert.equal(sandbox.firstMatching(rows, {}, "operations", 4).length, 4);
  assert.equal(sandbox.firstMatching(rows, {}, "operations", 0).length, 4);
  assert.equal(sandbox.firstMatching(rows, {}, "operations", 10).length, 10);
  assert.equal(sandbox.firstMatching(null, {}, "operations", 4).length, 0);
});
