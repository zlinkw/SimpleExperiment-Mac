const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDistributedResultsFlag } = require("../../dist/features/DistributedAdapterFlag.js");

test("distributed result opt-in accepts an inline YAML comment", () => {
  assert.equal(parseDistributedResultsFlag("true # formal comparison Plans"), true);
  assert.equal(parseDistributedResultsFlag(" false # legacy scheduler"), false);
  assert.equal(parseDistributedResultsFlag("not-true"), false);
});
