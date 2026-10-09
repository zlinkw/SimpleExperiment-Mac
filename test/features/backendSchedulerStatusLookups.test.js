const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name) {
  const start = extension.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = extension.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return extension.slice(start, end + 1);
}

function loadStatusHelpers() {
  const sandbox = {
    schedulerRowMatchesProtectedKey: (_row, protectedSet) => protectedSet.has("protected"),
    schedulerRowStatus: (row) => String((row || {}).status || ""),
    bucketStatusFromSchedulerBucket: (bucket) => String(bucket || "").replace("_experiments", ""),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("SCHEDULER_RUNNING_STATUSES"),
    extractConst("SCHEDULER_QUEUED_STATUSES"),
    extractConst("SCHEDULER_FAILURE_STATUSES"),
    extractConst("SCHEDULER_COMPLETED_STATUSES"),
    extractConst("SCHEDULER_TERMINAL_STATUSES"),
    extractFunction("schedulerEntryPriority"),
    extractFunction("schedulerStatusToken"),
    extractFunction("schedulerStatusRank"),
    extractFunction("schedulerStatusTerminal"),
    "this.api = { schedulerEntryPriority, schedulerStatusToken, schedulerStatusRank, schedulerStatusTerminal };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

function loadTraceRank() {
  const sandbox = {
    experimentTraceNeedsAttention: (row) => Boolean(row && row.attention),
    experimentTraceStatus: (row) => String((row || {}).status || ""),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("EXPERIMENT_TRACE_ACTIVE_STATUSES"),
    extractConst("EXPERIMENT_TRACE_TERMINAL_STATUSES"),
    extractFunction("experimentTraceRank"),
    "this.rank = experimentTraceRank;",
  ].join("\n"), sandbox);
  return sandbox.rank;
}

test("backend scheduler status classifiers reuse fixed sets", () => {
  const api = loadStatusHelpers();
  assert.equal(api.schedulerStatusToken("canceled"), "cancelled");
  assert.equal(api.schedulerStatusToken("normal_completed"), "completed");
  assert.equal(api.schedulerStatusToken("completed_with_errors"), "failed");
  assert.equal(api.schedulerStatusToken("manual_interrupted_completed"), "stopped");

  assert.equal(api.schedulerStatusRank("running"), 0);
  assert.equal(api.schedulerStatusRank("pending"), 1);
  assert.equal(api.schedulerStatusRank("completed_with_errors"), 2);
  assert.equal(api.schedulerStatusRank("future"), 3);
  assert.equal(api.schedulerStatusRank("normal_completed"), 4);
  assert.equal(api.schedulerStatusTerminal("normal_completed"), true);
  assert.equal(api.schedulerStatusTerminal("running"), false);

  assert.equal(api.schedulerEntryPriority({ status: "running" }, "", new Set(["protected"])), 0);
  assert.equal(api.schedulerEntryPriority({ status: "running" }, "", new Set()), 1);
  assert.equal(api.schedulerEntryPriority({ status: "failed" }, "", new Set()), 2);
  assert.equal(api.schedulerEntryPriority({ status: "pending" }, "", new Set()), 3);
  assert.equal(api.schedulerEntryPriority({ status: "future" }, "", new Set()), 4);
  assert.equal(api.schedulerEntryPriority({ status: "completed" }, "", new Set()), 5);

  for (const name of ["SCHEDULER_RUNNING_STATUSES", "SCHEDULER_QUEUED_STATUSES", "SCHEDULER_FAILURE_STATUSES", "SCHEDULER_COMPLETED_STATUSES", "SCHEDULER_TERMINAL_STATUSES"]) {
    assert.match(extension, new RegExp(`const ${name} = new Set\\(`));
  }
  assert.doesNotMatch(extractFunction("schedulerEntryPriority"), /\[[^\]]+\]\.includes/);
  assert.doesNotMatch(extractFunction("schedulerStatusRank"), /\[[^\]]+\]\.includes/);
  assert.doesNotMatch(extractFunction("schedulerStatusTerminal"), /\[[^\]]+\]\.includes/);
});

test("backend trace and Plan outcome classifiers reuse lifecycle sets", () => {
  const rank = loadTraceRank();
  assert.equal(rank({ status: "running" }), 1);
  assert.equal(rank({ status: "future" }), 2);
  assert.equal(rank({ status: "completed" }), 3);
  assert.equal(rank({ status: "completed", attention: true }), 0);

  for (const name of ["EXPERIMENT_TRACE_ACTIVE_STATUSES", "EXPERIMENT_TRACE_TERMINAL_STATUSES", "SCHEDULER_OUTCOME_FAILURE_STATUSES"]) {
    assert.match(extension, new RegExp(`const ${name} = new Set\\(`));
  }
  assert.match(extractFunction("projectBootstrapFinishedTaskOutcome"), /SCHEDULER_OUTCOME_FAILURE_STATUSES\.has/);
  assert.match(extractFunction("projectBootstrapFinishedRunOutcome"), /LONG_RUNNING_OPERATION_ACTIONS\.has/);
  assert.match(extractFunction("currentPlanRevisionHasRunEvidence"), /LONG_RUNNING_OPERATION_ACTIONS\.has/);
});
