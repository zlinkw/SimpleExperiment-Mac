const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MultiEndpointRealtimeClient, mergeWorkerResultsSummaries } = require("../../dist/tunnel/MultiEndpointRealtimeClient.js");
const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { readSource } = require("../_helpers/sourceReader");

const {
  workerTelemetryAllowedEvents,
  workerTelemetryAllowedActions,
  workerLocalSchedulerActionNames,
  workerResultActionNames,
  workerTelemetryForbiddenEndpoints,
  workerTelemetryRequiredEndpoints,
  validateWorkerTelemetryCapabilities,
} = require("../../dist/tunnel/WorkerTelemetryApi.js");

function productionWorkerTelemetryCapabilities() {
  const source = readSource("src/clusterAgentRuntime.legacy.ts");
  const fn = source.indexOf("def api_capabilities(");
  const branch = source.indexOf('if mode == "worker_telemetry":', fn);
  const actionsAt = source.indexOf('"actionEndpoints": {', branch);
  const endpointsAt = source.indexOf('"endpoints": {', branch);
  const endpointsBlock = source.slice(endpointsAt, actionsAt);
  const actionsEnd = source.indexOf("},", actionsAt);
  const names = (constant) => {
    const at = source.indexOf(`${constant} = `);
    assert.ok(at >= 0, constant);
    const brace = source.indexOf("{", at);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) return [...source.slice(brace, index + 1).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      }
    }
    throw new Error(`unterminated ${constant}`);
  };
  const quoted = (block, key) => [...block.matchAll(new RegExp(`"${key}":\\s*(True|False)`, "g"))].map((match) => [key, match[1] === "True"]);
  const endpoints = Object.fromEntries(["health", "capabilities", "gpu", "workerTasks", "codeSyncProof", "liveOutput", "diagnostics", "resultsSummary", "websocketEvents", "sseEvents", "actions", "fileList", "fileStat", "fileDownload", "fileRangeDownload", "fileUploadInit", "fileUploadChunk", "fileUploadComplete"].flatMap((key) => quoted(endpointsBlock, key)));
  const actionEndpoints = Object.fromEntries([...source.slice(actionsAt, actionsEnd).matchAll(/"([a-z0-9-]+)":\s*True/g)].map((match) => [match[1], true]));
  for (const name of [...names("WORKER_RESULT_ACTIONS"), ...names("WORKER_TENSORBOARD_ACTIONS"), ...names("WORKER_ENV_ACTIONS")]) actionEndpoints[name] = true;
  return { schemaVersion: 1, apiVersion: "1", agentVersion: "1", mode: "worker_telemetry", endpoints, actionEndpoints };
}

function panelFunction(name) {
  const source = readSource("src/ui/PanelHtml.ts");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("worker telemetry permits bounded worker controls plus local scheduler actions", () => {
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/gpu"));
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/worker/tasks"));
  assert.ok(workerTelemetryRequiredEndpoints.includes("/api/results/summary"));
  assert.deepEqual([...workerTelemetryAllowedActions].sort(), [
    "POST /api/actions/start-worker-task",
    "POST /api/actions/register-code-sync-proof",
    "POST /api/actions/rebuild-distributed-results",
    "POST /api/actions/retry-worker-task",
    "POST /api/actions/stop-worker-task",
    "POST /api/actions/stop-worker-task-exact-pane",
    "POST /api/actions/delete-worker-artifacts",
    "POST /api/actions/archive-worker-artifacts",
    "POST /api/actions/start-tensorboard",
    "POST /api/actions/stop-tensorboard",
    "POST /api/actions/get-tensorboard-status",
    "POST /api/actions/install-rich",
    "POST /api/actions/save-result-policy",
  ].sort());
  assert.deepEqual([...workerLocalSchedulerActionNames], ["validate-plan", "dry-run-plan", "run-plan", "reproduce-plan", "stop-scheduler-operation"]);
  assert.ok(workerResultActionNames.includes("parse-results"));
  assert.ok(workerResultActionNames.includes("archive-artifacts"));
  assert.equal(workerTelemetryForbiddenEndpoints.includes("POST /api/actions/parse-results"), false);
  assert.ok(workerTelemetryForbiddenEndpoints.includes("GET /api/files/list"));
  assert.equal(workerTelemetryForbiddenEndpoints.includes("GET /api/files/*"), false);
  assert.deepEqual([...workerTelemetryAllowedEvents].sort(), ["agent_heartbeat", "diagnostics_updated", "gpu_snapshot", "log_tail", "worker_health", "worker_task_snapshot"].sort());
});

test("worker capabilities tolerate missing file and action api", () => {
  const result = validateWorkerTelemetryCapabilities({
    schemaVersion: 1,
    mode: "worker_telemetry",
    apiVersion: "1",
    agentVersion: "1",
    endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, resultsSummary: true, liveOutput: true, diagnostics: true, websocketEvents: true, sseEvents: true, actions: false, fileList: false },
  });
  assert.equal(result.ok, true);
});

test("worker capabilities accept local scheduler actions and reject other Hub actions", () => {
  const base = {
    schemaVersion: 1,
    mode: "worker_telemetry",
    apiVersion: "1",
    agentVersion: "1",
    endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, resultsSummary: true, liveOutput: true, diagnostics: true, websocketEvents: true, sseEvents: true, actions: true, fileList: false },
  };
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "start-worker-task": true, "retry-worker-task": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "run-plan": true, "validate-plan": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "parse-results": true, "archive-artifacts": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "start-tensorboard": true, "stop-tensorboard": true, "get-tensorboard-status": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "install-rich": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "stop-worker-task-exact-pane": true } }).ok, true);
  assert.equal(validateWorkerTelemetryCapabilities({ ...base, actionEndpoints: { "deploy-runtime": true } }).ok, false);
  const readOnlyDownload = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, fileDownload: true, fileRangeDownload: true, fileList: false, fileUploadChunk: false },
    actionEndpoints: { "stop-worker-task-exact-pane": true },
  });
  assert.equal(readOnlyDownload.ok, true);
  assert.deepEqual(readOnlyDownload.warnings, []);
  const productionWorker = validateWorkerTelemetryCapabilities(productionWorkerTelemetryCapabilities());
  assert.equal(productionWorker.ok, true);
  assert.deepEqual(productionWorker.warnings, []);
  const writes = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, fileList: true, fileUploadChunk: true, fileUploadInit: true },
  });
  assert.equal(writes.ok, false);
  assert.match(writes.warnings.join("\n"), /不允许的文件写入或列表端点：fileList、fileUploadChunk、fileUploadInit/);
  const missingGpu = validateWorkerTelemetryCapabilities({
    ...base,
    endpoints: { ...base.endpoints, gpu: false },
  });
  assert.equal(missingGpu.ok, false);
  assert.match(missingGpu.warnings.join("\n"), /缺少端点：gpu/);
});

test("Worker-only client requires topology stamp and never substitutes Worker for Hub", async (context) => {
  // A rejected read must be independent of the user's live Agent/tunnel ports.
  context.mock.method(global, "fetch", async (url) => {
    assert.match(String(url), /\/api\/results\/summary$/);
    throw new TypeError("fetch failed");
  });
  const client = new MultiEndpointRealtimeClient([
    { id: "worker-1", role: "worker", localHost: "127.0.0.1", localPort: 23456 },
  ], () => new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {}, disabledPurposes: [] }));
  await assert.rejects(client.postWorkerAction("worker-1", "run-plan", {}), /action not allowed/);
  await assert.rejects(client.postWorkerAction("worker-1", "parse-results", {}), /action not allowed/);
  await assert.rejects(client.postAction("run-plan", {}), /Hub realtime endpoint not configured/);
  await assert.rejects(client.getResultsSummary(), /fetch failed|ECONNREFUSED|AbortError|timeout|No Worker endpoint|worker telemetry does not expose hub control api/);
});

test("Worker summaries merge read-only while preserving result ownership", () => {
  const merged = mergeWorkerResultsSummaries([
    { workerId: "worker-b", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", workerSetRevision: "set-1", results: [{ resultId: "same", finalEvidenceState: "pending_review" }] } },
    { workerId: "worker-a", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", workerSetRevision: "set-1", results: [{ resultId: "same", finalEvidenceState: "archived", metrics: { AUC: { value: 0.9 } } }] } },
  ], "experiments/plans/demo.yaml");
  assert.equal(merged.authoritative, false);
  assert.equal(merged.displayAggregateOnly, true);
  assert.equal(merged.resultCount, 2);
  assert.equal(merged.finalResultCount, 1);
  assert.equal(merged.incompleteAggregate, false);
  assert.equal(merged.aggregateCoverage, "2/2");
  assert.deepEqual(merged.workerIds, ["worker-a", "worker-b"]);
  assert.deepEqual(merged.results.map((row) => row.resultOwnershipKey).sort(), ["worker-a:same", "worker-b:same"]);
  assert.ok(merged.results.every((row) => row.workerId === row.resultOwnerWorkerId && row.provenance.workerId === row.workerId));
});

test("partial Worker summaries stay worker-pool scoped and disclose missing endpoints", () => {
  const merged = mergeWorkerResultsSummaries([
    { workerId: "worker-a", summary: { planFile: "experiments/plans/demo.yaml", planRevision: "rev-1", results: [{ resultId: "a", finalEvidenceState: "archived" }] } },
  ], "experiments/plans/demo.yaml", ["worker-a", "worker-b"]);
  assert.equal(merged.topologyMode, "worker_pool");
  assert.equal(merged.incompleteAggregate, true);
  assert.equal(merged.aggregateCoverage, "1/2");
  assert.deepEqual(merged.expectedWorkerIds, ["worker-a", "worker-b"]);
  assert.deepEqual(merged.availableWorkerIds, ["worker-a"]);
  assert.deepEqual(merged.unavailableWorkerIds, ["worker-b"]);
  assert.match(merged.message, /不是全局结果/);
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.match(panel, /function renderWorkerResultAggregateWarning\(summary\)/);
  assert.match(panel, /当前数字仅代表可用 Worker 的只读部分视图/);
});

test("no-Hub result buttons use the owning Worker capability instead of Hub capability", () => {
  const sandbox = {
    noHubWorkerResultCommands: new Set(["archiveArtifacts", "parseResults", "refreshResults"]),
    NO_HUB_TOPOLOGY_MODES: new Set(["single_worker", "worker_pool"]),
    asArray: (value) => Array.isArray(value) ? value : [],
    resolveWorkerId: (value) => String(value || "").trim(),
    uniqueText: (values) => [...new Set(values)],
    enabledWorkerTunnelsForState: (state) => state.setup.workerTunnels.filter((worker) => worker.enabled !== false),
    hasCapability: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(panelFunction("missingNoHubWorkerResultCapabilities") + "\nthis.check = missingNoHubWorkerResultCapabilities;", sandbox);
  const good = { status: "ok", capabilities: { endpoints: { actions: true, resultsSummary: true }, actionEndpoints: { "archive-artifacts": true, "parse-results": true } } };
  const stale = { status: "ok", capabilities: { endpoints: { actions: true, resultsSummary: false }, actionEndpoints: { "archive-artifacts": false, "parse-results": false } } };
  const state = {
    topology: { mode: "worker_pool" },
    setup: { workerTunnels: [{ id: "worker-a" }, { id: "worker-b" }] },
    workerProbes: { "worker-a": good, "worker-b": stale },
  };
  assert.deepEqual([...sandbox.check(state, "archiveArtifacts", ["actions.archive-artifacts"], { workerId: "worker-a" })], []);
  assert.deepEqual([...sandbox.check(state, "parseResults", ["actions.parse-results"], {})], ["worker-b: actions.parse-results"]);
  assert.deepEqual([...sandbox.check(state, "refreshResults", ["endpoints.resultsSummary"], {})], ["worker-b: endpoints.resultsSummary"]);
  assert.equal(sandbox.check({ ...state, topology: { mode: "hub_worker" } }, "parseResults", ["actions.parse-results"], {}), null);
});
