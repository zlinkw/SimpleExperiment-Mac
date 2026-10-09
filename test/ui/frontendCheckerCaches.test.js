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

function loadProjectReadinessChecks() {
  const sandbox = {
    HUB_OPERATION_READY_STATUS_TOKENS: new Set(["agent_ok", "ok", "file_api_unavailable"]),
    projectEndpointReadinessCacheState: null,
    projectEndpointReadinessCacheValue: null,
    projectCodeSyncReadinessCacheState: null,
    projectCodeSyncReadinessCacheValue: null,
    workerReads: 0,
    enabledWorkerTunnelsForState(state) {
      sandbox.workerReads += 1;
      return state.workers || [];
    },
    syncStatusOk(value) { return [true, "ok", "ready", "synced"].includes(value); },
    hasText(value) { return Boolean(String(value || "").trim()); },
    compactIdentifier(value) { return String(value || ""); },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("projectEndpointReadiness"),
    extractFunction("projectCodeSyncReadiness"),
    "this.endpoint = projectEndpointReadiness; this.codeSync = projectCodeSyncReadiness;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadRunEvidence() {
  const sandbox = {
    CURRENT_PLAN_RUN_EVIDENCE_CACHE_LIMIT: 2,
    PLAN_RUN_OPERATION_TYPES: new Set(["run-plan", "reproduce-plan"]),
    currentPlanRevisionRunEvidenceCacheState: null,
    currentPlanRevisionRunEvidenceCache: new Map(),
    operationReads: 0,
    schedulerReads: 0,
    meaningfulValue(value) { return String(value || "").trim(); },
    planFromContext() { return {}; },
    samePlanSelection(left, right) {
      const key = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      return key(left) === key(right);
    },
    operationMatchesPlanVersion(row, revision) { return !row.planRevision || row.planRevision === revision; },
    taskMatchesPlanVersion(row, revision) { return !row.planRevision || row.planRevision === revision; },
    operationRowsForState(state) { sandbox.operationReads += 1; return state.operations || []; },
    schedulerRowsForState(state) { sandbox.schedulerReads += 1; return state.schedulerStates || []; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("normalizePlanSelectionKey"),
    extractFunction("cacheCurrentPlanRevisionRunEvidence"),
    extractFunction("currentPlanRevisionRunEvidenceForState"),
    "this.evidence = currentPlanRevisionRunEvidenceForState;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadOutputContractCheck() {
  const sandbox = {
    currentResultOutputContractCheckCacheState: null,
    currentResultOutputContractCheckCacheValue: null,
    calls: 0,
    meaningfulValue(value) { return String(value || "").trim(); },
    pick(item, keys, fallback) {
      for (const key of keys) {
        if (item && item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
      }
      return fallback;
    },
    planFromContext(state) { return state.plan || {}; },
    latestResultOutputContractCheck() { return { call: ++sandbox.calls }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("currentResultOutputContractCheck")}\nthis.check = currentResultOutputContractCheck;`, sandbox);
  return sandbox;
}

test("project endpoint and code sync checks reuse one derivation per state", () => {
  const sandbox = loadProjectReadinessChecks();
  const state = {
    workers: [{ id: "worker-a", displayName: "Worker A" }],
    probe: { status: "ok", schedulerDependencies: { ok: true } },
    workerProbes: { "worker-a": { status: "ok", schedulerDependencies: { ok: true } } },
    codeSync: { hub: "ok", workers: "ok", fingerprint: "abc123" },
  };

  const endpoint = sandbox.endpoint(state);
  const codeSync = sandbox.codeSync(state);
  assert.strictEqual(sandbox.endpoint(state), endpoint);
  assert.strictEqual(sandbox.codeSync(state), codeSync);
  assert.equal(endpoint.ready, true);
  assert.equal(codeSync.ready, true);
  assert.equal(sandbox.workerReads, 2);

  assert.notStrictEqual(sandbox.endpoint({ ...state }), endpoint);
  assert.notStrictEqual(sandbox.codeSync({ ...state }), codeSync);
  assert.equal(sandbox.workerReads, 4);
});

test("current Plan revision evidence cache preserves false values and stays bounded", () => {
  const sandbox = loadRunEvidence();
  const state = { operations: [], schedulerStates: [] };
  const plan = { revision: "rev1", updatedAt: "2026-07-20T01:00:00.000Z" };
  const first = sandbox.evidence(state, "./plans/demo.yaml", plan);

  assert.equal(first, false);
  assert.equal(sandbox.evidence(state, "plans\\demo.yaml", plan), false);
  assert.equal(sandbox.operationReads, 1);
  assert.equal(sandbox.schedulerReads, 1);

  assert.equal(sandbox.evidence(state, "plans/demo.yaml", { ...plan, revision: "rev2" }), false);
  assert.equal(sandbox.operationReads, 2);
  assert.equal(sandbox.schedulerReads, 2);

  const operationState = {
    operations: [{ type: "run-plan", planFile: "plans/demo.yaml", planRevision: "rev1", submissionAccepted: true }],
    schedulerStates: [],
  };
  assert.equal(sandbox.evidence(operationState, "plans/demo.yaml", plan), true);
  assert.equal(sandbox.schedulerReads, 2);

  sandbox.evidence(operationState, "plans/a.yaml", plan);
  sandbox.evidence(operationState, "plans/b.yaml", plan);
  sandbox.evidence(operationState, "plans/c.yaml", plan);
  assert.ok(sandbox.currentPlanRevisionRunEvidenceCache.size <= 2);
});

test("Plan run evidence lookups reuse the fixed operation type set", () => {
  for (const name of ["planActiveRunEvidence", "planExecutionStage", "currentPlanRevisionRunEvidenceForState"]) {
    assert.match(extractFunction(name), /PLAN_RUN_OPERATION_TYPES\??\.has\(/, name);
  }
  assert.equal((panel.match(/const PLAN_RUN_OPERATION_TYPES = new Set/g) || []).length, 1);
  assert.doesNotMatch(panel, /\["run-plan", "reproduce-plan"\]\.includes\(/);
});

test("current output contract check reuses the selected state result", () => {
  const sandbox = loadOutputContractCheck();
  const state = {
    planFileInput: "plans/demo.yaml",
    plan: { revision: "rev1", updatedAt: "2026-07-20T01:00:00.000Z" },
    resultsSummary: { lastParsedAt: "2026-07-20T02:00:00.000Z" },
  };
  const first = sandbox.check(state);

  assert.strictEqual(sandbox.check(state), first);
  assert.equal(sandbox.calls, 1);
  assert.notStrictEqual(sandbox.check({ ...state }), first);
  assert.equal(sandbox.calls, 2);
});
