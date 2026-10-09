const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionSource = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const planFile = "experiments/plans/comparison/eyemost_plus.yaml";
const hostSchedulerRows = [];

function extractBlock(name) {
  const lines = extensionSource.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^(?:    (?:(?:private|public|protected) )?(?:async )?|function |const )${name}\\b`).test(line));
  assert.ok(start >= 0, name);
  let depth = 0;
  let seen = false;
  for (let index = start; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) || []).length - (lines[index].match(/\}/g) || []).length;
    if ((lines[index].match(/\{/g) || []).length) seen = true;
    if (seen && depth <= 0) {
      return lines.slice(start, index + 1).join("\n").replace(/^[ \t]*(?:private|public|protected)[ \t]+/gm, "").replace(/: any/g, "").replace(/ as const/g, "").replace(/(\w|\)|\]|\}) as [A-Za-z_$][\w$]*/g, "$1");
    }
  }
  throw new Error(`unclosed ${name}`);
}

function createContext(extra = {}) {
  const context = {
    Error,
    Set,
    String,
    Number,
    Boolean,
    Date,
    Object,
    Array,
    Map,
    JSON,
    Math,
    Promise,
    AbortController,
    uniqueStrings: (values) => [...new Set((values || []).filter(Boolean).map(String))],
    stringField: (record, key) => String(record?.[key] || ""),
    numberField: (record, key) => Number(record?.[key] || 0),
    stringArrayField: (record, keys) => {
      const values = [keys].flat().map((key) => record?.[key]).find(Array.isArray);
      return Array.isArray(values) ? values.map(String) : [];
    },
    operationResultPlanFile: (row) => String(row?.planFile || row?.plan || row?.options?.planFile || ""),
    usableSelectionKey: (value) => String(value || "").trim(),
    operationTerminal: (row) => ["completed", "failed", "cancelled", "succeeded"].includes(String(row?.status || "").toLowerCase()),
    operationTerminalStatus: (value) => ["completed", "failed", "cancelled", "succeeded"].includes(String(value || "").toLowerCase()),
    operationStatusOf: (row) => String(row?.status || row?.state || ""),
    operationStatusToken: (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, "_"),
    normalizePlanSelectionKey: (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, ""),
    samePlanSelection: (left, right) => String(left || "").replace(/\\/g, "/").toLowerCase() === String(right || "").replace(/\\/g, "/").toLowerCase() && Boolean(left),
    planArchiveSchedulerRowsForState: () => hostSchedulerRows,
    ACTIVE_PLAN_RUN_STATUSES: new Set(["accepted", "submitted", "queued", "pending", "running", "testing", "progress", "in_progress", "operation_started", "started"]),
    ACTIVE_PLAN_RUN_EVIDENCE_VARIANT_CACHE_LIMIT: 8,
    activePlanRunEvidenceCache: new WeakMap(),
    EMPTY_ACTIVE_PLAN_RUN_EVIDENCE_STATE: Object.freeze({}),
    EMPTY_ACTIVE_PLAN_RUN_OPERATIONS: Object.freeze({}),
    EMPTY_PLAN_ARCHIVE_SCHEDULER_ROWS: Object.freeze([]),
    remoteResultOperationPayloads: (row) => [row || {}],
    operationSubmissionAccepted: (row) => Boolean(row && (row.submissionAccepted === true || row.schedulerStarted === true)),
    LONG_RUNNING_OPERATION_ACTIONS: new Set(["run-plan", "reproduce-plan"]),
    errorMessage: (error) => String((error && error.message) || error || ""),
    LocalApiError: class LocalApiError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    RunOperations_1: {
      reconcileRunOperation: (record, evidence) => ({
        terminal: evidence.schedulerFinished === true,
        patch: { ...record, status: evidence.schedulerFinished === true ? "completed" : record.status, reconcileEvidenceActive: true },
      }),
    },
    ...extra,
  };
  vm.createContext(context);
  return context;
}

function loadHost() {
  const context = createContext();
  const helpers = ["planSubmitProgress", "activePlanRunEvidence"].map(extractBlock).join("\n");
  const methods = [
    "beginPlanSubmissionProgress",
    "trimPlanSubmissionEpochs",
    "planSubmissionOperationId",
    "planSubmissionPlanFile",
    "patchPlanSubmissionProgress",
    "finishPlanSubmissionProgress",
    "longRunningPlanRunOperations",
    "runOperationWorkerId",
    "runOperationEvidenceWorkerId",
    "collectRunOperationEvidence",
    "reconcileStalePlanRunOperations",
    "pollRunningEvidenceAndMerge",
    "assertPlanNotAlreadyActive",
  ].map((name) => extractBlock(name)).join(",\n");
  vm.runInContext(`${helpers}\nconst methods = { ${methods} };\nthis.api = methods;`, context);
  const host = {
    localOperations: {},
    distributedSubmissionEpochs: new Map(),
    posts: 0,
    evidenceCalls: [],
    reconcilePolls: 0,
    evidencePolls: 0,
    isRealtimeMode: () => true,
    projectTopologyAssessment: () => ({ mode: "worker_pool", hubAllowed: false }),
    enabledWorkerConfigs: () => [{ id: "worker-a" }, { id: "worker-b" }],
    resolveWorkerEndpointId: (value) => (value === "worker-a" || value === "worker-b" ? value : ""),
    markLocalOperationsDirty() {},
    postState() { this.posts += 1; },
    buildPlanRuntimeEvidenceState() {
      return { operations: this.localOperations, schedulerStates: this.schedulerStates || [] };
    },
    client: {
      async getRunEvidence(workerId, params) {
        host.evidenceCalls.push({ workerId, operationId: params.operationId });
        if (workerId === "worker-b") return { schedulerFinished: true, pidAlive: false, tmuxSessionAlive: false };
        return { pidAlive: true, tmuxSessionAlive: true };
      },
    },
    scheduleRunOperationReconcilePoll() { host.reconcilePolls += 1; },
    scheduleEvidenceAutoPoll() { host.evidencePolls += 1; },
    queueCompletedPlanArtifactSync() { return Promise.resolve(); },
    recordActionError() {},
  };
  Object.assign(host, context.api);
  return { context, host };
}

function message() {
  return { command: "runPlan", clientActionId: "click-eyemost", planFile };
}

test("ownerless plan-submit progress stays visible and skips worker evidence", async () => {
  const { context, host } = loadHost();
  context.api.beginPlanSubmissionProgress.call(host, message(), { planFile, planRevision: "rev-eye" });
  const row = host.localOperations["plan-submit-click-eyemost"];
  assert.equal(row.type, "run-plan");
  assert.equal(row.localSubmissionProgress, true);
  assert.equal(row.status, "running");
  assert.equal(row.planFile, planFile);
  assert.equal(context.api.longRunningPlanRunOperations.call(host).length, 0);

  const reconciled = await context.api.reconcileStalePlanRunOperations.call(host, { reason: "duplicate_guard" });
  assert.deepEqual(host.evidenceCalls, []);
  assert.deepEqual([...reconciled.checked], []);
  assert.equal(row.status, "running");

  await context.api.pollRunningEvidenceAndMerge.call(host);
  assert.deepEqual(host.evidenceCalls, []);

  context.api.patchPlanSubmissionProgress.call(host, message(), "running", "正在选择调度 Worker…");
  assert.match(host.localOperations["plan-submit-click-eyemost"].message, /正在选择调度 Worker/);
  context.api.finishPlanSubmissionProgress.call(host, message(), "failed", "校验或预演未通过，未提交运行。");
  assert.equal(host.localOperations["plan-submit-click-eyemost"].status, "failed");
  assert.equal(host.localOperations["plan-submit-click-eyemost"].finishedAt.length > 0, true);

  host.localOperations = {};
  context.api.beginPlanSubmissionProgress.call(host, message(), { planFile });
  context.api.finishPlanSubmissionProgress.call(host, message(), "cancelled", "已取消，未提交运行。");
  assert.equal(host.localOperations["plan-submit-click-eyemost"].status, "cancelled");
});

test("assertPlanNotAlreadyActive ignores local submit progress and keeps a real active run", async () => {
  const { context, host } = loadHost();
  context.api.beginPlanSubmissionProgress.call(host, message(), { planFile, planRevision: "rev-eye" });
  await context.api.assertPlanNotAlreadyActive.call(host, planFile, { planFile, revision: "rev-eye" });

  host.localOperations["remote-run"] = {
    operationId: "remote-run",
    type: "run-plan",
    status: "running",
    planFile,
    planRevision: "rev-eye",
    schedulerOwnerWorkerId: "worker-a",
    reconcileEvidenceActive: true,
    submissionAccepted: true,
  };
  await assert.rejects(
    () => context.api.assertPlanNotAlreadyActive.call(host, planFile, { planFile, revision: "rev-eye" }),
    /已阻止重复提交/,
  );
  assert.deepEqual(host.evidenceCalls.map((call) => call.operationId), ["remote-run"]);
});

test("remote run-plan still requires an explicit owner and does not take down other records", async () => {
  const { context, host } = loadHost();
  host.localOperations["missing-owner"] = {
    operationId: "missing-owner",
    type: "run-plan",
    status: "running",
    planFile,
    reconcileEvidenceActive: true,
  };
  host.localOperations["owned"] = {
    operationId: "owned",
    type: "run-plan",
    status: "running",
    planFile: "experiments/plans/comparison/other.yaml",
    schedulerOwnerWorkerId: "worker-b",
  };
  const result = await context.api.reconcileStalePlanRunOperations.call(host, { reason: "activation" });
  assert.equal(host.localOperations["missing-owner"].status, "running");
  assert.match(host.localOperations["missing-owner"].lastReconcileError, /缺少 schedulerOwnerWorkerId 或 resultOwnerWorkerId/);
  assert.deepEqual([...result.checked], ["owned"]);
  assert.equal(host.localOperations.owned.status, "completed");
  assert.deepEqual(host.evidenceCalls.map((call) => call.workerId), ["worker-b"]);
  assert.throws(
    () => context.api.runOperationEvidenceWorkerId.call(host, host.localOperations["missing-owner"]),
    /缺少 schedulerOwnerWorkerId 或 resultOwnerWorkerId/,
  );
});

test("refreshed plan-submit id without an acceptance stamp stays local", async () => {
  const { context, host } = loadHost();
  host.localOperations["plan-submit-restored"] = {
    operationId: "plan-submit-restored",
    type: "run-plan",
    status: "running",
    planFile,
    stage: "prepare",
  };
  assert.equal(context.api.longRunningPlanRunOperations.call(host).length, 0);
  const reconciled = await context.api.reconcileStalePlanRunOperations.call(host, { reason: "activation" });
  assert.deepEqual([...reconciled.checked], []);
  assert.equal(host.localOperations["plan-submit-restored"].lastReconcileError, undefined);
});
