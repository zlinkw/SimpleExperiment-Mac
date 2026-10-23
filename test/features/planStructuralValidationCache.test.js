const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");

function method(name) {
  const start = source.indexOf(`    async ${name}(`) >= 0 ? source.indexOf(`    async ${name}(`) : source.indexOf(`    ${name}(`);
  const end = source.indexOf("\n    }", start) + 6;
  assert.ok(start >= 0 && end > start, name);
  const member = source.slice(start, end);
  const compiled = ts.transpileModule(`const object = {${member}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return compiled.slice(compiled.indexOf("{") + 1, compiled.lastIndexOf("}"));
}

test("verified Agent content cache refreshes outputs, invalidates changed inputs, and stays bounded", () => {
  const agent = require("../../dist/clusterAgentRuntime.legacy.js").CLUSTER_AGENT_RUNTIME;
  const result = spawnSync("python", ["-X", "utf8", path.join(root, "test/fixtures/plan_preflight_cache_probe.py")], { input: JSON.stringify({ agent }), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, cacheEntries: 32, warmSchedulerCalls: 0 });
});

test("warm Host preflight still requests fresh artifacts and reads queue/GPU on every attempt", async () => {
  const compiled = method("runPlanPreflight");
  const runner = new Function("workspaceRoot", "remoteActionPendingStatus", "resultStatus", "planCheckAccepted",
    "remoteOperationDurationMs", "planValidationFromResult", "DistributedPlanQueue", "isUiCommandCancelled",
    "isUiCommandRemotePending", "errorMessage", "actionErrorSuggestion", `return {${compiled}};`)(
      () => "C:/fixture", (status) => status === "submitted", (value) => value.status,
      (value) => value.ok === true, () => undefined, (value) => value.validation,
      { previewAvailable: (_queue, _jobs, workers) => ({ workers }) }, () => false, () => false,
      (error) => error.message, () => "check").runPlanPreflight;
  let count = 0, gpuReads = 0, queueReads = 0;
  const host = {
    assertActionAuthorityCurrent() {}, planSchedulerWorkerId: () => "worker-a", enabledWorkerConfigs: () => [],
    distributedPlanEligible: () => true, planValidationCacheKey: () => "key", cachedPlanValidation: () => ({ validation: { existing: [{ index: 99 }] } }),
    planValidationCache: new Map(), rememberPlanValidation() {},
    async postPlanSchedulerAction(action) {
      assert.equal(action, "validate-plan"); count += 1;
      return { ok: true, status: "completed", validation: { jobs: [{ index: 0, case: "dataset", seed: 42, output_dir: "work/output" }],
        existing: count === 1 ? [] : [{ index: 0 }], structuralValidationReused: true } };
    },
    async loadDistributedQueue() { queueReads += 1; return { plans: [{ jobs: [{ status: "running", workerId: "worker-a", gpuId: 0 }] }] }; },
    client: { async getGpu(options) { assert.equal(options.dispatch, true); gpuReads += 1; return {}; } },
    localWorkerAvailabilityRows: () => [{ workerId: "worker-a", availableGpuIds: [0, 1] }], availabilityPushTtlSeconds: () => 10,
    schedulerSettings: () => ({}), lastWorkerProbes: { "worker-a": { status: "ok" } },
    lastCodeSyncState: { fingerprint: "content", workerVersions: { "worker-a": { fingerprint: "content" } } },
  };
  const body = { planFile: "plans/a.yaml", planRevision: "r" };
  const first = await runner.call(host, body, "test");
  const second = await runner.call(host, body, "test");
  assert.deepEqual(first.validation.existing, []);
  assert.deepEqual(second.validation.existing, [{ index: 0 }]);
  assert.equal(count, 2); assert.equal(gpuReads, 2); assert.equal(queueReads, 2);
  assert.deepEqual(second.distributedPreview.workers[0].idleGpuIds, [1], "live occupied GPU must remain excluded");
  const submission = await runner.call(host, body, "run", { previewResources: false });
  assert.equal(count, 3, 'submission still queries current remote artifacts');
  assert.equal(gpuReads, 2, 'actual dispatch performs admission; submission avoids a redundant resource-only query');
  assert.equal(queueReads, 2, 'submission does not simulate allocation against historical queue rows');
  assert.equal(submission.distributedPreview.admissionDeferred, true);
  assert.deepEqual(submission.validation.existing, [{ index: 0 }]);
});

test('real capability version enables structural reuse and every relevant change invalidates it', () => {
  const key = new Function('workspaceRoot', 'normalizePlanSelectionKey', 'pluginProjectAdapterRules', 'crypto',
    `return {${method('planValidationCacheKey')}};`)(() => 'C:/fixture', String, () => ({}), require('node:crypto')).planValidationCacheKey;
  const worker = {id:'w',condaEnv:'/env',agentProjectDir:'/project'};
  const host = {lastWorkerProbes:{w:{capabilities:{agentVersion:'0.5.326'}}},
    projectTopologyAssessment:()=>({mode:'worker_pool'}),enabledWorkerConfigs:()=>[worker],
    lastCodeSyncState:{fingerprint:'content',workerVersions:{w:{codeSyncProofRuntimeGeneration:'generation'}}}};
  const body = {planFile:'experiments/plans/a.yaml',planRevision:'revision'};
  const first = key.call(host,body,'w'); assert.match(first,/^[a-f0-9]{64}$/);
  assert.equal(key.call(host,body,'w'),first);
  for (const change of [()=>body.planRevision='new',()=>host.lastCodeSyncState.fingerprint='new',
    ()=>host.lastWorkerProbes.w.capabilities.agentVersion='next',()=>worker.condaEnv='/new-env',
    ()=>host.lastCodeSyncState.workerVersions.w.codeSyncProofRuntimeGeneration='new-generation']) {
    const previous=key.call(host,body,'w'); change(); assert.notEqual(key.call(host,body,'w'),previous);
  }
  host.lastWorkerProbes.w = {}; assert.equal(key.call(host,body,'w'),'');
});

test("warm and cold validation both return the original async identity before filesystem work", () => {
  const agent = require("../../dist/clusterAgentRuntime.legacy.js").CLUSTER_AGENT_RUNTIME;
  const post = agent.slice(agent.indexOf("        def do_POST(self):"));
  const next = post.indexOf('if action in ("validate-plan", "dry-run-plan", "preflight-worker-task", "rebuild-distributed-results")');
  assert.ok(next > post.indexOf('"local worker scheduler identity mismatch"'));
  const block = post.slice(0, next);
  assert.doesNotMatch(block, /cached_scheduler_validation\(root/);
  assert.match(post.slice(next), /start_inactivity_action/);
});

test("both explicit validation and run preflight send only current proof identities without mutating the request", async () => {
  const api = new Function("DistributedPlanQueue", "workspaceRoot", `return {${method("postPlanSchedulerAction")}};`)(
    { canonicalProjectId: () => "project" }, () => "C:/fixture").postPlanSchedulerAction;
  const key = "a".repeat(64);
  const requests = [];
  const host = {
    assertActionAuthorityCurrent() {}, assertPlanTopologyReady: () => ({ mode: "worker_pool" }),
    planSchedulerWorkerId: () => "worker-a", planValidationCacheKey: () => key,
    lastCodeSyncState: { fingerprint: "content", workerVersions: { "worker-a": {
      fingerprint: "content", codeSyncProofId: "proof", manifestDigest: "content" } } },
    async postWorkerPoolPlanAction(action, body) { requests.push({ action, body }); return { ok: true }; },
  };
  const original = { planFile: "experiments/plans/a.yaml", options: { overwriteExisting: false } };
  await api.call(host, "validate-plan", original);
  assert.deepEqual(requests[0].body.options.validationCodeProof, { projectId: "project", codeSyncProofId: "proof",
    codeFingerprint: "content", manifestDigest: "content" });
  assert.equal(requests[0].body.options.structuralValidationKey, key);
  assert.equal(original.options.structuralValidationKey, undefined);
  host.lastCodeSyncState.fingerprint = "changed";
  await api.call(host, "validate-plan", original);
  assert.equal(requests[1].body.options.validationCodeProof, undefined, "stale proof cannot enable content reuse");
  await api.call(host, "run-plan", original);
  assert.equal(requests[2].body.options.validationCodeProof, undefined, "preflight hint never authorizes actual dispatch");
});
