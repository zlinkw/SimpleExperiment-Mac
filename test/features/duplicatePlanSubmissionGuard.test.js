const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractMethod(source, name) {
  const start = source.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `missing method ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated method ${name}`);
}

function samePlanSelection(left, right) {
  const key = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const a = key(left);
  const b = key(right);
  return Boolean(a && b && (a === b || a.split("/").pop() === b.split("/").pop()));
}

function loadExtensionGuard() {
  const sandbox = {
    ACTIVE_PLAN_RUN_EVIDENCE_VARIANT_CACHE_LIMIT: 3,
    ACTIVE_PLAN_RUN_STATUSES: new Set(["accepted", "submitted", "queued", "pending", "running", "testing", "progress", "in_progress", "operation_started", "started"]),
    EMPTY_ACTIVE_PLAN_RUN_EVIDENCE_STATE: Object.freeze({}),
    EMPTY_ACTIVE_PLAN_RUN_OPERATIONS: Object.freeze({}),
    EMPTY_PLAN_ARCHIVE_SCHEDULER_ROWS: Object.freeze([]),
    activePlanRunEvidenceCache: new WeakMap(),
    payloadReads: 0,
    normalizePlanSelectionKey: (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, ""),
    operationResultPlanFile: (row) => String((row || {}).planFile || (row || {}).plan || ""),
    samePlanSelection,
    operationStatusToken: (value) => String(value || "").trim().toLowerCase(),
    operationStatusOf: (row) => String((row || {}).status || (row || {}).state || (row || {}).type || ""),
    remoteResultOperationPayloads: (row) => {
      sandbox.payloadReads += 1;
      return [row || {}, (row || {}).payload || {}, (row || {}).latestEvent || {}, ((row || {}).latestEvent || {}).payload || {}];
    },
    flattenPlanArchiveSchedulerRows: (rows) => Array.isArray(rows) ? rows.flatMap((row) => {
      const out = [];
      for (const [key, status] of [["running_experiments", "running"], ["testing_experiments", "testing"], ["queued_experiments", "queued"], ["pending_experiments", "pending"], ["completed_experiments", "completed"]]) {
        for (const child of Array.isArray((row || {})[key]) ? row[key] : []) out.push({ ...child, status, planFile: child.planFile || row.planFile });
      }
      return out.length ? out : [row];
    }) : [],
    planArchiveSchedulerRowsForState: (state) => sandbox.flattenPlanArchiveSchedulerRows((state || {}).schedulerStates || []),
  };
  vm.createContext(sandbox);
  const progressStart = extension.indexOf("const planSubmitProgress = {");
  const progressEnd = extension.indexOf("export class RealtimeTunnelPanelProvider", progressStart);
  assert.ok(progressStart >= 0 && progressEnd > progressStart);
  vm.runInContext(`${extension.slice(progressStart, progressEnd)}\nthis.planSubmitProgress = planSubmitProgress;`, sandbox);
  vm.runInContext(`${extractFunction(extension, "activePlanRunEvidence")}\nthis.guard = activePlanRunEvidence;`, sandbox);
  sandbox.guard.cache = sandbox.activePlanRunEvidenceCache;
  sandbox.guard.sandbox = sandbox;
  return sandbox.guard;
}

function loadPanelGuard() {
  const sandbox = {
    normalizePlanSelectionKey: (value) => String(value || "").replace(/\\/g, "/"),
    samePlanSelection,
    operationRowsForState: (state) => state.operations || [],
    schedulerRowsForState: (state) => state.schedulerStates || [],
    PLAN_ACTIVE_STATUSES: new Set(["accepted", "submitted", "queued", "pending", "running", "testing", "progress", "in_progress", "operation_started", "started"]),
    PLAN_RUN_OPERATION_TYPES: new Set(["run-plan", "reproduce-plan"]),
    planActiveRunEvidenceCacheState: null,
    planActiveRunEvidenceCache: new Map(),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(panel, "planActiveRunEvidence")}\nthis.guard = planActiveRunEvidence;`, sandbox);
  return sandbox.guard;
}

function loadPlanRunActions(activity = { active: false }) {
  const sandbox = {
    escAttr: (value) => String(value || ""),
    planFromContext: () => ({ status: "completed" }),
    planActiveRunEvidence: () => activity,
    esc: value => String(value || ""),
    planExecutionStage: () => ({ phase: "results", status: "已完成" }),
    projectNextAction: () => "",
    renderRuntimeContractRecoveryActions: () => "",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(panel, "renderPlanRunActions")}\nthis.render = renderPlanRunActions;`, sandbox);
  return sandbox.render;
}

function loadPlanRuntimeEvidenceCache() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(extension, "planRuntimeEvidenceCacheMatches")}\n${extractFunction(extension, "resolvePlanRuntimeEvidenceCache")}\nthis.resolveCache = resolvePlanRuntimeEvidenceCache;`, sandbox);
  return sandbox.resolveCache;
}

test("backend reuses Plan runtime evidence merge only for identical sources", () => {
  const resolveCache = loadPlanRuntimeEvidenceCache();
  const realtimeState = {};
  const snapshot = {};
  const offlineSnapshot = {};
  const localOperations = {};
  const input = {
    projectContextGeneration: 1,
    connectionMode: "xshell_tunnel_realtime",
    realtimeState,
    snapshot,
    offlineSnapshot,
    localOperations,
    localOperationsRevision: 3,
    schedulerProtectedKey: '["run-a"]',
  };
  let builds = 0;
  const build = () => ({ build: ++builds });
  const first = resolveCache(undefined, input, build);
  const reused = resolveCache(first, { ...input }, build);

  assert.strictEqual(reused, first);
  assert.strictEqual(reused.value, first.value);
  assert.equal(builds, 1);

  for (const [field, value] of [
    ["projectContextGeneration", 2],
    ["connectionMode", "offline_import"],
    ["realtimeState", {}],
    ["snapshot", {}],
    ["offlineSnapshot", {}],
    ["localOperations", {}],
    ["localOperationsRevision", 4],
    ["schedulerProtectedKey", '["run-b"]'],
  ]) {
    assert.notStrictEqual(resolveCache(first, { ...input, [field]: value }, build), first, field);
  }
  assert.equal(builds, 9);
  assert.match(extension, /private localOperationsRevision = 0/);
  assert.match(extension, /markLocalOperationsDirty\(\)\s*\{\s*this\.localOperationsDirty = true;\s*this\.localOperationsRevision \+= 1;/);
  assert.match(extension, /this\.planRuntimeEvidenceCache = resolvePlanRuntimeEvidenceCache/);
  assert.match(extension, /return this\.planRuntimeEvidenceCache\.value/);
});

test("backend blocks duplicate run operations and active scheduler tasks for the same Plan", () => {
  assert.match(extension, /private buildPlanRuntimeEvidenceState\(\)/);
  const buildStateStart = extension.indexOf("private buildState(");
  const buildStateEnd = extension.indexOf("\n    private ", buildStateStart + 10);
  assert.ok(buildStateStart >= 0 && buildStateEnd > buildStateStart);
  assert.match(extension.slice(buildStateStart, buildStateEnd), /this\.buildPlanRuntimeEvidenceState\(\)/);
  assert.doesNotMatch(extension, /activePlanRunEvidence\(this\.buildState\(\)/);
  assert.doesNotMatch(extension, /currentPlanRevisionHasRunEvidence\(this\.buildState\(\)/);
  const guard = loadExtensionGuard();
  const planFile = "experiments/plans/smoke.yaml";
  const empty = guard({ operations: {} }, planFile);
  assert.equal(empty.active, false);
  assert.equal(empty.operationCount, 0);
  assert.equal(empty.taskCount, 0);
  const operation = guard({ operations: { op: { type: "run-plan", status: "accepted", planFile } } }, planFile);
  assert.equal(operation.active, true);
  assert.equal(operation.operationCount, 1);
  assert.equal(guard({ operations: { op: { type: "run-plan", status: "completed", planFile } } }, planFile).active, false);
  assert.equal(guard({ operations: { op: { type: "run-plan", status: "running", planFile, schedulerFinished: true } } }, planFile).active, false);
  assert.equal(guard({ operations: { op: { type: "run-plan", status: "running", planFile: "other.yaml" } } }, planFile).active, false);
  const task = guard({ schedulerStates: [{ planFile, running_experiments: [{ id: "job-1" }] }] }, planFile);
  assert.equal(task.active, true);
  assert.equal(task.taskCount, 1);
});

test("confirmed inactive operation does not block the selected Plan", () => {
  const planFile = "experiments/plans/comparison/concatenation.yaml";
  const guard = loadExtensionGuard();
  const localSubmit = { operationId: "plan-submit-click", type: "run-plan", status: "running", planFile, localSubmissionProgress: true, reconcileEvidenceActive: false };
  assert.equal(guard({ operations: { local: localSubmit } }, planFile).active, false);
  const stale = { type: "run-plan", status: "running", planFile, reconcileEvidenceActive: false };
  assert.equal(loadExtensionGuard()({ operations: { stale }, schedulerStates: [] }, planFile).active, false);
  assert.equal(loadPanelGuard()({ operations: [stale], schedulerStates: [] }, planFile).active, false);
  assert.equal(loadPanelGuard()({ operations: [{ ...stale, reconcileEvidenceActive: true }] }, planFile).active, true);
});

test("completed Plan outputs stay rerunnable while true active evidence keeps the hard guard", () => {
  const planFile = "experiments/plans/comparison/concatenation.yaml";
  const render = loadPlanRunActions();
  const html = render({ operations: [], schedulerStates: [] }, planFile, true, undefined, undefined);
  assert.match(html, /data-command="runPlan"/);
  assert.doesNotMatch(html, /data-command="runPlan"[^>]*disabled/);
  assert.doesNotMatch(html, /overwriteExistingToggle|data-overwrite-toggle/);

  const guardSource = extractMethod(extension, "assertPlanNotAlreadyActive");
  assert.ok(guardSource.indexOf("await this.reconcileStalePlanRunOperations") < guardSource.indexOf("activePlanRunEvidence"));
  assert.doesNotMatch(guardSource, /force\s*=|force\s*\)/);
  const guard = loadExtensionGuard();
  const outputs = Array.from({ length: 6 }, (_, index) => ({ index, completed: true }));
  assert.equal(outputs.length, 6);
  assert.equal(guard({ operations: {}, schedulerStates: [] }, planFile).active, false);
  assert.equal(guard({ operations: { active: { type: "run-plan", status: "running", planFile } } }, planFile).active, true);
  assert.equal(guard({ operations: { stale: { type: "run-plan", status: "running", planFile, reconcileEvidenceActive: false } }, schedulerStates: [] }, planFile).active, false);
});

test("complete outputs cannot bypass a live guard, but reconciled inactive operations can proceed", async () => {
  const planFile = "experiments/plans/comparison/concatenation.yaml";
  const completeOutputs = Array.from({ length: 6 }, (_, index) => ({ index, completed: true }));
  const guard = new Function("activePlanRunEvidence", "LocalApiError", "samePlanSelection", "operationResultPlanFile", "uniqueStrings", `
    return ({ ${extractMethod(extension, "assertPlanNotAlreadyActive")} }).assertPlanNotAlreadyActive;
  `)(loadExtensionGuard(), class LocalApiError extends Error { constructor(_code, message) { super(message); } }, samePlanSelection,
    (row) => String((row || {}).planFile || row.plan || ""), (values) => [...new Set(values)]);
  let state = { operations: { live: { type: "run-plan", status: "running", planFile } }, schedulerStates: [] };
  const host = {
    localPlanMetadata: { plans: [] },
    async reconcileStalePlanRunOperations() {},
    buildPlanRuntimeEvidenceState: () => state,
    longRunningPlanRunOperations: () => Object.values(state.operations),
  };
  await assert.rejects(() => guard.call(host, planFile, { existingOutputs: completeOutputs }), /未结束的运行/);
  state = { ...state, operations: { live: { ...state.operations.live, reconcileEvidenceActive: false } } };
  host.reconcileStalePlanRunOperations = async () => {};
  await assert.doesNotReject(() => guard.call(host, planFile, { existingOutputs: completeOutputs }));
});

test("selected Plan stays first in dropdown after switching", () => {
  const names = ["planFileOf", "collectPlanFileDefaultOrder", "resolvePlanFileCurrent", "matchPlanFileInOrder", "refreshPlanFileOptions"];
  const select = { innerHTML: "", value: "" };
  const sandbox = { planSelectorStatusIndex: () => ({}), planSelectorRunSummary: () => ({ status: "unknown", statusLabel: "待确认", totalCount: 0 }), planSelectorMatchesFilter: () => true, planSelectorSortEntries: rows => rows.slice(), planSelectorOptionLabel: file => file, el: id => id === "planFileInput" ? select : null, esc: (value) => value, escAttr: (value) => value, samePlanSelection };
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(panel, name)).join("\n") + "\nthis.refresh = refreshPlanFileOptions;", sandbox);
  const plans = [{ file: "experiments/plans/baseline.yaml" }, { file: "experiments/plans/comparison/concatenation.yaml" }];
  sandbox.refresh({ plans, planFileInput: "experiments/plans/comparison/concatenation.yaml" });
  assert.match(select.innerHTML, /^<option[^>]* value="experiments\/plans\/comparison\/concatenation\.yaml">/);
  assert.equal(select.value, "experiments/plans/comparison/concatenation.yaml");
  select.value = "experiments/plans/baseline.yaml";
  sandbox.refresh({ plans });
  assert.match(select.innerHTML, /^<option[^>]* value="experiments\/plans\/baseline\.yaml">/);
  assert.equal(select.value, "experiments/plans/baseline.yaml");
  assert.match(panel, /reconcileEvidenceActive: pick\(row,/);
});

test("backend protects active old revisions without misclassifying them as current", () => {
  const guard = loadExtensionGuard();
  const planFile = "experiments/plans/smoke.yaml";
  const plan = { revision: "rev2", updatedAt: "2026-07-20T01:00:00.000Z" };
  const oldOperation = guard({ operations: { op: { type: "run-plan", status: "running", planFile, planRevision: "rev1", updatedAt: "2026-07-20T01:05:00.000Z" } } }, planFile, plan);
  assert.equal(oldOperation.active, true);
  assert.equal(oldOperation.historicalOnly, true);
  assert.equal(oldOperation.currentOperationCount, 0);
  assert.equal(oldOperation.historicalOperationCount, 1);

  const oldTask = guard({ schedulerStates: [{ planFile, running_experiments: [{ id: "job-old", planRevision: "rev1", updatedAt: "2026-07-20T01:05:00.000Z" }] }] }, planFile, plan);
  assert.equal(oldTask.active, true);
  assert.equal(oldTask.historicalOnly, true);
  assert.equal(oldTask.currentTaskCount, 0);

  const current = guard({ operations: { op: { type: "run-plan", status: "running", planFile, planRevision: "rev2" } } }, planFile, plan);
  assert.equal(current.active, true);
  assert.equal(current.historicalOnly, false);
  assert.equal(current.currentOperationCount, 1);
});

test("backend reuses bounded current Plan activity evidence and invalidates source replacements", () => {
  const guard = loadExtensionGuard();
  const planFile = "experiments/plans/smoke.yaml";
  const state = {
    operations: { op: { type: "run-plan", status: "running", planFile } },
    schedulerStates: [],
  };
  const plan = { revision: "r1", updatedAt: "2026-07-30T00:00:00.000Z" };
  const first = guard(state, planFile, plan);
  const payloadReads = guard.sandbox.payloadReads;

  assert.strictEqual(guard(state, planFile, { ...plan }), first);
  assert.equal(guard.sandbox.payloadReads, payloadReads);

  const nextRevision = guard(state, planFile, { ...plan, revision: "r2" });
  assert.notStrictEqual(nextRevision, first);
  state.operations = { op: { type: "run-plan", status: "completed", planFile } };
  const operationRefresh = guard(state, planFile, { ...plan, revision: "r2" });
  assert.notStrictEqual(operationRefresh, nextRevision);
  assert.equal(operationRefresh.active, false);

  state.schedulerStates = [{ planFile, running_experiments: [{ id: "job-1", planRevision: "r2" }] }];
  const schedulerRefresh = guard(state, planFile, { ...plan, revision: "r2" });
  assert.notStrictEqual(schedulerRefresh, operationRefresh);
  assert.equal(schedulerRefresh.taskCount, 1);

  const oldest = guard(state, "plans/0.yaml", { revision: "r0" });
  for (let index = 1; index < 4; index += 1) guard(state, `plans/${index}.yaml`, { revision: `r${index}` });
  assert.equal(guard.cache.get(state).size, 3);
  assert.notStrictEqual(guard(state, "plans/0.yaml", { revision: "r0" }), oldest);
});

test("webview routes active Plans to confirmed restart while the Host duplicate guard remains strict", () => {
  const guard = loadPanelGuard();
  const planFile = "experiments/plans/smoke.yaml";
  const state = { operations: [{ type: "reproduce-plan", status: "submitted", planFile }] };
  const first = guard(state, planFile);
  assert.equal(first.operationCount, 1);
  assert.equal(guard(state, planFile), first);
  assert.equal(guard({ schedulerStates: [{ status: "queued", planFile }] }, planFile).taskCount, 1);
  assert.equal(guard({ operations: [{ type: "run-plan", status: "completed", planFile }] }, planFile).active, false);
  const planActivity = extractFunction(panel, "planActiveRunEvidence");
  assert.match(planActivity, /planActiveRunEvidenceCache\?\.has\(cacheKey\)/);
  assert.match(planActivity, /for \(const row of operationRowsForState/);
  assert.match(planActivity, /for \(const row of schedulerRowsForState/);
  assert.doesNotMatch(planActivity, /\.filter\(/);
  const html = loadPlanRunActions(first)(state, planFile, true);
  assert.match(html, /data-command="runPlan"/);
  assert.match(html, /停止并重新运行/);
  assert.match(html, /查看运行进度/);
  assert.match(extension, /assertPlanNotAlreadyActive[\s\S]{0,2600}已阻止重复提交/);
});

test("webview explains old revision activity and opens Plan runtime progress", () => {
  const guard = loadPanelGuard();
  const planFile = "experiments/plans/smoke.yaml";
  const plan = { revision: "rev2", updatedAt: "2026-07-20T01:00:00.000Z" };
  const activity = guard({ schedulerStates: [{ planFile, status: "running", planRevision: "rev1", updatedAt: "2026-07-20T01:05:00.000Z" }] }, planFile, plan);
  assert.equal(activity.active, true);
  assert.equal(activity.historicalOnly, true);
  assert.equal(activity.currentTaskCount, 0);
  assert.match(panel, /旧 revision 的/);
  assert.match(panel, /查看运行进度/);
  assert.doesNotMatch(panel, /taskPlanScope|data-task-plan-scope/);
  assert.match(panel, /const anchor = "execution-operations"/);
  assert.match(extension, /旧 Plan revision 仍有/);
  assert.match(extension, /next === "查看运行进度"/);
});
