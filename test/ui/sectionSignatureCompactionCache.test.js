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

function loadCompaction() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    SIGNATURE_COMPACTION_VARIANT_LIMIT: 3,
    compactRowsForSignatureCache: new WeakMap(),
    compactObjectMapForSignatureCache: new WeakMap(),
    asArray(value) {
      return Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("compactRecordForSignature"),
    extractFunction("compactRowsForSignature"),
    extractFunction("compactObjectMapForSignature"),
    "this.compactRows = compactRowsForSignature; this.compactMap = compactObjectMapForSignature;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("row signature compaction reuses stable source and equivalent parameters", () => {
  const sandbox = loadCompaction();
  let reads = 0;
  const rows = [{ id: "a", get status() { reads += 1; return "running"; }, ignored: true }];
  const first = sandbox.compactRows(rows, 8, ["id", "status"]);

  assert.strictEqual(sandbox.compactRows(rows, 8, ["id", "status"]), first);
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { count: 1, rows: [{ id: "a", status: "running" }] });

  const differentFields = sandbox.compactRows(rows, 8, ["id"]);
  const differentLimit = sandbox.compactRows(rows, 1, ["id", "status"]);
  assert.notStrictEqual(differentFields, first);
  assert.notStrictEqual(differentLimit, first);

  const replacement = sandbox.compactRows([{ id: "b", status: "queued" }], 8, ["id", "status"]);
  assert.notStrictEqual(replacement, first);
  assert.equal(replacement.rows[0].id, "b");
});

test("object-map signature compaction reuses stable source and preserves entry order", () => {
  const sandbox = loadCompaction();
  const source = {
    workerB: { status: "queued", ignored: 2 },
    workerA: { status: "running", ignored: 1 },
  };
  const first = sandbox.compactMap(source, 8, ["status"]);

  assert.strictEqual(sandbox.compactMap(source, 8, ["status"]), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    count: 2,
    rows: [
      { id: "workerB", status: "queued" },
      { id: "workerA", status: "running" },
    ],
  });

  const replacement = sandbox.compactMap({ workerC: { status: "done" } }, 8, ["status"]);
  assert.notStrictEqual(replacement, first);
  assert.equal(replacement.rows[0].id, "workerC");
});

test("signature compaction keeps only bounded recent parameter variants", () => {
  const sandbox = loadCompaction();
  const rows = [{ id: "a", status: "running", role: "worker", port: 1000 }];
  const map = { a: rows[0] };
  const oldestRows = sandbox.compactRows(rows, 1, ["id"]);
  const oldestMap = sandbox.compactMap(map, 1, ["id"]);

  for (const keys of [["status"], ["role"], ["port"]]) {
    sandbox.compactRows(rows, 1, keys);
    sandbox.compactMap(map, 1, keys);
  }

  assert.equal(sandbox.compactRowsForSignatureCache.get(rows).size, 3);
  assert.equal(sandbox.compactObjectMapForSignatureCache.get(map).size, 3);
  assert.notStrictEqual(sandbox.compactRows(rows, 1, ["id"]), oldestRows);
  assert.notStrictEqual(sandbox.compactMap(map, 1, ["id"]), oldestMap);
});
