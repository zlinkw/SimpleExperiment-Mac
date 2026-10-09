const test = require("node:test");
const assert = require("node:assert/strict");

const { touchBoundedTimestampMap } = require("../../dist/core/BoundedTimestampMap.js");

test("bounded timestamp map prunes expired idle keys and refreshes LRU order", () => {
  const map = new Map([["old", 100], ["fresh", 950], ["current", 990]]);
  const removed = touchBoundedTimestampMap(map, "current", 1_000, { limit: 3, maxAgeMs: 100 });
  assert.equal(removed, 1);
  assert.deepEqual([...map.entries()], [["fresh", 950], ["current", 1_000]]);
});

test("bounded timestamp map evicts oldest idle keys but retains protected keys", () => {
  const map = new Map([["protected", 1], ["oldest", 2], ["middle", 3], ["latest", 4]]);
  touchBoundedTimestampMap(map, "latest", 5, {
    limit: 3,
    maxAgeMs: 1_000,
    protectedKeys: new Set(["protected"]),
  });
  assert.deepEqual([...map.entries()], [["protected", 1], ["middle", 3], ["latest", 5]]);
});
