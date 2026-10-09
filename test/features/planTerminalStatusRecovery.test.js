const test = require("node:test");
const assert = require("node:assert/strict");
require("../_helpers/registerTsRequire");
const { summarizePlanStatuses } = require("../../src/features/PanelPlanStatusSummary.ts");

const normal = "experiments/plans/comparison/method.yaml";
const tuning = "experiments/plans/comparison_tuning/method.yaml";
const plans = [{ file: normal, revision: "normal", jobCount: 6 }, { file: tuning, revision: "tuning", jobCount: 36 }];

test("a cancelled Plan submission does not remain running or become completed", () => {
  const rows = summarizePlanStatuses({ plans, operations: [{ planFile: tuning, planRevision: "tuning", type: "run-plan", status: "cancelled" }] });
  assert.equal(rows[1].status, "partial");
  assert.equal(rows[1].activeCount, 0);
  assert.equal(rows[1].completedCount, 0);
});

test("completed distributed jobs outrank historical running operations", () => {
  const rows = summarizePlanStatuses({ plans, operations: [{ planFile: normal, planRevision: "normal", type: "run-plan", status: "running", updatedAt: "2026-10-09T01:00:00Z" }],
    distributedPlans: [{ planFile: normal, revision: "normal", enqueuedAt: "2026-10-09T00:00:00Z", jobs: Array.from({ length: 6 }, (_, index) => ({ index, status: "completed", updatedAt: "2026-10-09T02:00:00Z" })) }] });
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].completedCount, 6);
});

test("a newer actual submission still takes precedence over an older completed run", () => {
  const rows = summarizePlanStatuses({ plans, operations: [{ planFile: normal, planRevision: "normal", type: "run-plan", status: "running", startedAt: "2026-10-09T03:00:00Z", updatedAt: "2026-10-09T03:00:00Z" }],
    distributedPlans: [{ planFile: normal, revision: "normal", enqueuedAt: "2026-10-09T00:00:00Z", jobs: Array.from({ length: 6 }, (_, index) => ({ index, status: "completed", updatedAt: "2026-10-09T02:00:00Z" })) }] });
  assert.equal(rows[0].status, "running");
});

test("qualified paths and ambiguous legacy basenames do not mix normal and tuning plans", () => {
  const sharedRevision = plans.map(plan => ({ ...plan, revision: "shared" }));
  const qualified = summarizePlanStatuses({ plans: sharedRevision, operations: [{ planFile: normal, planRevision: "shared", type: "run-plan", status: "running" }] });
  assert.equal(qualified[0].status, "running");
  assert.equal(qualified[1].status, "not-started");
  const ambiguous = summarizePlanStatuses({ plans: sharedRevision, operations: [{ planFile: "method.yaml", planRevision: "shared", type: "run-plan", status: "running" }] });
  assert.equal(ambiguous[0].status, "not-started");
  assert.equal(ambiguous[1].status, "not-started");
});

test("a finished Plan with missing jobs remains incomplete rather than running or successful", () => {
  const rows = summarizePlanStatuses({ plans, operations: [{ planFile: normal, planRevision: "normal", type: "run-plan", status: "completed" }],
    distributedPlans: [{ planFile: normal, revision: "normal", jobs: [{ index: 0, status: "completed" }, { index: 1, status: "completed" }] }] });
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].completedCount, 2);
  assert.equal(rows[0].totalCount, 6);
});
