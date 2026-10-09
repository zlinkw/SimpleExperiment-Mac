const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeOperationRows } = require("../../dist/ui/WebviewRenderState.js");

test("operation normalize renders operation event variants", () => {
  const rows = normalizeOperationRows({
    op1: { type: "operation_progress", progress: 40, message: "running", updated_at: "2026-07-01T00:00:01Z" },
    op2: { operation_id: "op2", type: "operation_failed", error: "boom", updated_at: "2026-07-01T00:00:02Z" },
    op3: { operationId: "op3", type: "operation_completed", completed_at: "2026-07-01T00:00:03Z" },
    op4: { operationId: "op4", type: "operation_stalled", updated_at: "2026-07-01T00:00:04Z" },
  });
  assert.equal(rows[0].operationId, "op4");
  assert.equal(rows[0].status, "stalled");
  assert.equal(rows[1].status, "completed");
  assert.equal(rows[1].terminalAt, "2026-07-01T00:00:03Z");
  assert.equal(rows[1].updatedAt, "2026-07-01T00:00:03Z");
  assert.equal(rows[2].status, "failed");
  assert.equal(rows[3].status, "running");
});

test("operation normalize keeps recent twenty rows", () => {
  const rows = normalizeOperationRows(Array.from({ length: 25 }, (_, index) => ({ id: `op-${index}`, updatedAt: `2026-07-01T00:00:${String(index).padStart(2, "0")}Z` })));
  assert.equal(rows.length, 20);
  assert.equal(rows[0].operationId, "op-24");
});
