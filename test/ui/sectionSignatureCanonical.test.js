const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/ui/PanelHtml.ts");

function loadStableSectionSignature() {
  const start = source.indexOf("    function stableSectionSignature");
  const end = source.indexOf("    function stableSectionJson", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  return new Function(`${block}; return stableSectionSignature;`)();
}

test("section signatures ignore equivalent object insertion order", () => {
  const signature = loadStableSectionSignature();
  const first = { z: 3, nested: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] };
  const second = { a: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 3 };
  assert.equal(signature(first), signature(second));
  assert.notEqual(signature({ rows: [1, 2] }), signature({ rows: [2, 1] }));
});
