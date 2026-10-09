const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { runOperationMatchesTarget } = require("../../dist/features/RunOperations");

const extensionSource = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const operationTerminal = (row) => terminalStatuses.has(String(row?.status || ""));

function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method ${signature}`);
  let parentheses = 0;
  let cursor = start + signature.length;
  while (cursor < source.length) {
    if (source[cursor] === "(") parentheses += 1;
    if (source[cursor] === ")") parentheses -= 1;
    if (parentheses === 0 && source[cursor] === "{") break;
    cursor += 1;
  }
  const bodyStart = cursor;
  assert.ok(bodyStart > start, `missing body for ${signature}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1).replace(/(\w|\)|\]|\}) as [A-Za-z_$][\w$]*/g, "$1");
    }
  }
  throw new Error(`unterminated method ${signature}`);
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
    Promise,
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    stringField: (record, key) => String(record?.[key] || ""),
    numberField: (record, key) => Number(record?.[key] || 0),
    stringArrayField: (record, keys) => {
      const values = [keys].flat().map((key) => record?.[key]).find(Array.isArray);
      return Array.isArray(values) ? values.map(String) : [];
    },
    operationResultPlanFile: (row) => String(row?.planFile || row?.plan || row?.options?.planFile || ""),
    usableSelectionKey: (value) => String(value || "").trim(),
    operationTerminal: (row) => ["completed", "failed", "cancelled"].includes(String(row?.status || "")),
    makeOpId: (prefix) => `${prefix}-${Math.random().toString(16).slice(2)}`,
    resultStatus: (record) => String(record?.status || ""),
    stringFromRecord: (record, keys) => keys.map((key) => String(record?.[key] || "")).find(Boolean) || "",
    LONG_RUNNING_OPERATION_ACTIONS: new Set(["run-plan", "reproduce-plan"]),
    sanitizeAllowedGpuIds: (ids) => {
      const raw = Array.isArray(ids) ? ids : typeof ids === "string" ? String(ids).split(/[,\s]+/) : [];
      const trimmed = raw.map((item) => String(item || "").trim()).filter(Boolean);
      if (!trimmed.length) return [];
      if (trimmed.length === 1 && (trimmed[0] === "-" || trimmed[0] === "--")) return [];
      if (trimmed.some((value) => value === "-" || value === "--")) return [];
      const invalid = trimmed.filter((value) => !/^\d+$/.test(value));
      if (invalid.length) return [];
      return [...new Set(trimmed)];
    },
    normalizeCondaEnvSetting: (value) => String(value ?? "").trim(),
    errorMessage: (error) => String((error && error.message) || error || ""),
    ...extra,
  };
  vm.createContext(context);
  const progressStart = extensionSource.indexOf("const planSubmitProgress = {");
  const progressEnd = extensionSource.indexOf("export class RealtimeTunnelPanelProvider", progressStart);
  assert.ok(progressStart >= 0 && progressEnd > progressStart);
  vm.runInContext(`${extensionSource.slice(progressStart, progressEnd)}\nthis.planSubmitProgress = planSubmitProgress;`, context);
  return context;
}

test("Plan stop supplies its reason without waiting for a VS Code picker", async () => {
  let pickerCalls = 0;
  const context = createContext({
    vscode: { window: { showQuickPick: async () => { pickerCalls += 1; throw new Error("unexpected picker"); } } },
  });
  const source = extensionSource.replace("async ensureManualStopReason(command, body)", "async ensureManualStopReason(command, body, message = {})");
  const method = extractMethod(source, "async ensureManualStopReason(command, body, message = {})");
  vm.runInContext(`const methods = { ${method} }; this.ensureManualStopReason = methods.ensureManualStopReason;`, context);
  const body = { planFile: "experiments/plans/current.yaml" };
  await context.ensureManualStopReason("stopExperiment", body, { operationId: "run-plan-current", planFile: body.planFile });
  assert.equal(pickerCalls, 0);
  assert.equal(body.stopReason, "scheduler_aborted");
});

test("single-worker stop routes by Plan to the sole Worker without Hub", async () => {
  const calls = [];
  const operation = {
    operationId: "run-plan-old",
    type: "run-plan",
    status: "running",
    planFile: "experiments/plans/demo.yaml",
    schedulerOwnerWorkerId: "nwpu3",
  };
  const provider = {
    resolveWorkerEndpointId: (value) => String(value || "").trim(),
    localOperations: { [operation.operationId]: { ...operation } },
    projectTopologyAssessment: () => ({ mode: "single_worker", hubAllowed: false }),
    enabledWorkerConfigs: () => [{ id: "nwpu3" }],
    longRunningPlanRunOperations() {
      return Object.values(this.localOperations).filter((row) => !operationTerminal(row));
    },
    runOperationWorkerId: (row) => String(row.schedulerOwnerWorkerId || ""),
    stopExperimentMatchesTarget: (row, target) => runOperationMatchesTarget(row, target),
    async postWorkerTunnelAction(workerId, action, request) {
      calls.push({ workerId, action, request });
      return { status: "completed", matchedOperations: ["run-plan-old"], terminatedSessions: ["simple-scheduler-old"] };
    },
    markLocalOperationsDirty() {},
    postState() {},
  };

  const result = await contextStop(provider, { operationId: operation.operationId, planFile: "experiments\\plans\\demo.yaml" });

  assert.deepEqual(calls.map((call) => [call.workerId, call.action]), [["nwpu3", "stop-scheduler-operation"]]);
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.deepEqual([...result.matchedOperations], ["run-plan-old"]);
  assert.equal(provider.localOperations["run-plan-old"].status, "completed");
});

test("single-worker orphan stop stays running with manual hint when no process is terminated", async () => {
  const operation = {
    operationId: "run-plan-orphan",
    type: "run-plan",
    status: "running",
    planFile: "experiments/plans/orphan.yaml",
    schedulerOwnerWorkerId: "nwpu3",
  };
  const provider = {
    resolveWorkerEndpointId: (value) => String(value || "").trim(),
    localOperations: { [operation.operationId]: { ...operation } },
    projectTopologyAssessment: () => ({ mode: "single_worker", hubAllowed: false }),
    enabledWorkerConfigs: () => [{ id: "nwpu3" }],
    longRunningPlanRunOperations() {
      return Object.values(this.localOperations).filter((row) => !operationTerminal(row));
    },
    runOperationWorkerId: (row) => String(row.schedulerOwnerWorkerId || ""),
    stopExperimentMatchesTarget: (row, target) => runOperationMatchesTarget(row, target),
    async postWorkerTunnelAction() {
      return { status: "completed", matchedOperations: ["run-plan-orphan"] };
    },
    markLocalOperationsDirty() {},
    postState() {},
  };

  const result = await contextStop(provider, { operationId: operation.operationId, planFile: "experiments/plans/orphan.yaml" });

  assert.equal(result.stopped, 0);
  // 定案：取消 stale 终态，orphan 保持 running 由用户手动处理
  assert.equal(provider.localOperations["run-plan-orphan"].status, "running");
  assert.equal(provider.localOperations["run-plan-orphan"].finishedAt, undefined);
  assert.match(provider.localOperations["run-plan-orphan"].message, /未自动终结/);
  assert.equal(provider.localOperations["run-plan-orphan"].reconcileReason, "stop:no_remote_activity");
});

test("single-worker stop still matches a reconciled submission staying running with manual hint", async () => {
  const calls = [];
  const operation = {
    operationId: "run-plan-stale",
    type: "run-plan",
    status: "stale",
    planFile: "experiments/plans/stale.yaml",
    schedulerOwnerWorkerId: "nwpu3",
  };
  const provider = {
    resolveWorkerEndpointId: (value) => String(value || "").trim(),
    localOperations: { [operation.operationId]: { ...operation } },
    projectTopologyAssessment: () => ({ mode: "single_worker", hubAllowed: false }),
    enabledWorkerConfigs: () => [{ id: "nwpu3" }],
    longRunningPlanRunOperations() {
      return [];
    },
    runOperationWorkerId: (row) => String(row.schedulerOwnerWorkerId || ""),
    stopExperimentMatchesTarget: (row, target) => runOperationMatchesTarget(row, target),
    async postWorkerTunnelAction(workerId, action, request) {
      calls.push({ workerId, action, request });
      return { status: "completed", matchedOperations: ["run-plan-stale"] };
    },
    markLocalOperationsDirty() {},
    postState() {},
  };

  const result = await contextStop(provider, { operationId: operation.operationId, planFile: operation.planFile });

  assert.deepEqual(calls.map((call) => call.action), ["stop-scheduler-operation"]);
  assert.equal(result.stopped, 0);
  assert.deepEqual([...result.matchedOperations], ["run-plan-stale"]);
  // 定案：历史 stale 输入经兼容匹配后转为 running 提示，不再保持 stale 终态
  assert.equal(provider.localOperations["run-plan-stale"].status, "running");
  assert.match(provider.localOperations["run-plan-stale"].message, /未自动终结/);
});

async function contextStop(provider, body) {
  const context = createContext({
    resolveWorkerEndpointId: (value) => String(value || "").trim(),
  });
  const method = extractMethod(extensionSource, "async stopExperimentRouted(body)");
  vm.runInContext(`const methods = { ${method} };\nthis.stopExperimentRouted = methods.stopExperimentRouted;`, context);
  return context.stopExperimentRouted.call(provider, body);
}

test("result parse idempotency keys include workspace, Plan version, and owner", () => {
  const context = createContext({
    workspaceRoot: () => "C:\\work\\project",
    sha256Text: (value) => {
      sha256Inputs.push(value);
      return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
    },
  });
  const sha256Inputs = [];
  const provider = {
    resolveWorkerEndpointId: (value) => String(value || "").trim(),
    localPlanForActionBody(message) {
      const file = this.stringPlanFile(message);
      return file === "plans/demo.yaml" ? { revision: "rev-1" } : {};
    },
    stringPlanFile(message) {
      return message.options.planFile;
    },
    planSchedulerWorkerId(message) {
      return message.options.selectedWorkerIds?.[0] || "default";
    },
  };
  const method = extractMethod(extensionSource, "resultParseIdempotencyKey(command, message)");
  vm.runInContext(`const methods = { ${method} };\nthis.resultParseIdempotencyKey = methods.resultParseIdempotencyKey;`, context);
  const key = context.resultParseIdempotencyKey.bind(provider);
  const message = {
    planFile: "plans/demo.yaml",
    selectedWorkerIds: ["nwpu3"],
    options: { planFile: "plans/demo.yaml", selectedWorkerIds: ["nwpu3"] },
  };
  const expectedInput = [
    "C:\\work\\project", "parseResults", "plans/demo.yaml", "rev-1", "nwpu3",
  ].join("\n");

  assert.equal(key("parseResults", message).length, 64);
  assert.equal(sha256Inputs.at(-1), expectedInput);
  assert.equal(key("refreshResults", message).length, 64);
  assert.notEqual(key("parseResults", message), key("parseResults", {
    ...message,
    selectedWorkerIds: ["nwpu4"],
    options: { ...message.options, selectedWorkerIds: ["nwpu4"] },
  }));
});

test("concurrent result parses merge into one active operation", async () => {
  assert.match(extensionSource, /resultParseInFlight = new Map\(\)/);
  const context = createContext({
    RESULT_PARSE_COMMANDS: new Set(["parseResults", "refreshResults"]),
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "reproducePlan"]),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    HostOperationLeaseConflictError: class HostOperationLeaseConflictError extends Error {},
    HostOperationLease_1: { HostOperationLeaseConflictError: class HostOperationLeaseConflictError extends Error {} },
  });
  const method = extractMethod(extensionSource, "async runActionCommand(command, message)");
  vm.runInContext(`const methods = { ${method} };\nthis.runActionCommand = methods.runActionCommand;`, context);
  const provider = {
    resultParseInFlight: new Map(),
    localOperations: {},
    resultParseIdempotencyKey: () => "parse-key",
    activeResultParseOperation(keyValue) {
      return Object.values(this.localOperations).find((row) => row.resultParseKey === keyValue && !operationTerminal(row));
    },
    async runActionCommandLeased() {
      calls += 1;
      this.localOperations.operation = { operationId: "operation", status: "running", resultParseKey: "parse-key" };
      await wait(30);
      return this.localOperations.operation;
    },
    async loadProjectLocalOperationsState() {},
  };
  let calls = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const first = context.runActionCommand.call(provider, "parseResults", {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await context.runActionCommand.call(provider, "parseResults", {});
  const firstResult = await first;

  assert.equal(calls, 1);
  assert.equal(firstResult.merged, undefined);
  assert.equal(second.merged, true);
  assert.equal(firstResult.operationId, "operation");
  assert.equal(second.operationId, "operation");
});

test("runActionCommand executes the default action branch and returns its result", async () => {
  const context = createContext({
    RESULT_PARSE_COMMANDS: new Set(["parseResults"]),
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "reproducePlan"]),
  });
  const method = extractMethod(extensionSource, "async runActionCommand(command, message)");
  vm.runInContext(`const methods = { ${method} };\nthis.runActionCommand = methods.runActionCommand;`, context);
  let leased = 0;
  const provider = {
    async runActionCommandLeased(command, message) {
      leased += 1;
      return { ok: true, command, message };
    },
  };

  const result = await context.runActionCommand.call(provider, "stopExperiment", { planFile: "plans/demo.yaml" });

  assert.equal(leased, 1);
  assert.equal(result.ok, true);
  assert.equal(result.command, "stopExperiment");
});

test("single-worker evidence uses the configured Worker endpoint and never falls back to Hub", async () => {
  const selectorContext = createContext({});
  const selectorMethod = extractMethod(extensionSource, "runOperationEvidenceWorkerId(record)");
  vm.runInContext(`const methods = { ${selectorMethod} };\nthis.select = methods.runOperationEvidenceWorkerId;`, selectorContext);
  const context = createContext({});
  const collectMethod = extractMethod(extensionSource, "async collectRunOperationEvidence(record)");
  vm.runInContext(`const methods = { ${collectMethod} };\nthis.collect = methods.collectRunOperationEvidence;`, context);
  let requestedWorkerId = "";
  const provider = {
    projectTopologyAssessment: () => ({ mode: "single_worker", hubAllowed: false }),
    enabledWorkerConfigs: () => [{ id: "nwpu3" }],
    resolveWorkerEndpointId: (value) => value === "nwpu3" ? value : "",
    runOperationWorkerId: (record) => String(record.schedulerOwnerWorkerId || ""),
    runOperationEvidenceWorkerId(record) {
      return selectorContext.select.call(this, record);
    },
    client: {
      async getRunEvidence(workerId) {
        requestedWorkerId = workerId;
        return { checkedPid: 2402941, checkedTmuxSession: "zlk-scheduler-old", schedulerStatesCount: 0, liveLogCount: 0 };
      },
    },
  };
  const record = {
    operationId: "old",
    planFile: "plans/demo.yaml",
    pid: 2402941,
    tmuxSession: "zlk-scheduler-old",
    schedulerOwnerWorkerId: "nwpu3",
  };

  assert.equal(selectorContext.select.call(provider, record), "nwpu3");
  const result = await context.collect.call(provider, record);
  assert.equal(requestedWorkerId, "nwpu3");
  assert.equal(result.ok, true);
  assert.equal(result.workerId, "nwpu3");
});

test("project.prepare merges partial Worker rows without resetting concurrency", () => {
  const context = createContext({
    normalizeCondaEnvSetting: (value) => String(value ?? "").trim(),
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
  });
  const method = extractMethod(extensionSource, "apiMergedWorkerConfigs(workerTunnels, setup = this.setupConfig)");
  vm.runInContext(`const methods = { ${method} };\nthis.merge = methods.apiMergedWorkerConfigs;`, context);
  const provider = {};
  const merged = context.merge.call(provider, [{ id: "nwpu3", condaEnv: "zlk" }], {
    agentProjectDir: "/data/qgking/zlk",
    condaEnv: "fallback",
    workerTunnels: [{
      id: "nwpu3",
      displayName: "NWPU3",
      maxConcurrentGpus: 4,
      allowedGpuIds: ["0", "1", "1"],
      condaEnv: "old",
      agentProjectDir: "/data/qgking/zlk",
    }],
  });
  const worker = merged.find((row) => row.id === "nwpu3");

  assert.equal(worker.maxConcurrentGpus, 4);
  assert.deepEqual([...worker.allowedGpuIds], ["0", "1", "1"]);
  assert.equal(worker.condaEnv, "zlk");
});

test("project.prepare setup merge preserves an existing Worker concurrency value", () => {
  const context = createContext({
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    normalizeCondaEnvSetting: (value) => String(value ?? "").trim(),
    XshellTunnelSetup_1: {
      normalizeXshellSetupConfig: (input) => ({ ...input }),
    },
  });
  const method = extractMethod(extensionSource, "apiMergedSetupConfig(params = {})");
  vm.runInContext(`const methods = { ${method} };\nthis.mergeSetup = methods.apiMergedSetupConfig;`, context);
  const provider = {
    setupConfig: {
      localForwardPort: 18765,
      remoteAgentPort: 18765,
      workerTunnels: [{
        id: "nwpu3",
        displayName: "NWPU3",
        host: "gpu.example",
        user: "researcher",
        port: 22,
        maxConcurrentGpus: 4,
        allowedGpuIds: ["0", "1"],
        condaEnv: "zlk",
        agentProjectDir: "/data/qgking/zlk",
      }],
    },
  };
  const merged = context.mergeSetup.call(provider, { workerTunnels: [{ id: "nwpu3", condaEnv: "zlk" }] });
  const worker = merged.workerTunnels.find((row) => row.id === "nwpu3");

  assert.equal(worker.maxConcurrentGpus, 4);
  assert.equal(worker.agentProjectDir, "/data/qgking/zlk");
});

test("formal run evidence excludes old operations and accepts a new active submission", () => {
  const context = createContext({});
  const method = extractMethod(extensionSource, "runSubmissionEvidence(record, knownOperationIds)");
  vm.runInContext(`const methods = { ${method} };\nthis.evidence = methods.runSubmissionEvidence;`, context);
  const provider = {
    localOperations: {
      newRun: { operationId: "newRun", type: "run-plan", status: "accepted" },
      oldRun: { operationId: "oldRun", type: "run-plan", status: "running" },
    },
  };
  const known = new Set(["workflow-run", "oldRun"]);

  assert.equal(context.evidence.call(provider, provider.localOperations.oldRun, known), null);
  assert.match(JSON.stringify(context.evidence.call(provider, provider.localOperations.newRun, known)), /"submissionOperationId":"newRun"/);
});

test("run workflow gates duplicate blockers and requires submission evidence", () => {
  const start = extensionSource.indexOf("async apiWorkflowRun(params = {})");
  const end = extensionSource.indexOf("async runApiWorkflowOperation", start);
  const runWorkflow = extensionSource.slice(start, end);
  assert.match(runWorkflow, /STALE_LOCAL_RUN_OPERATION/);
  assert.match(runWorkflow, /ACTIVE_PLAN_RUN_EXISTS/);
  assert.match(extensionSource, /RUN_SUBMISSION_EVIDENCE_MISSING/);
  assert.match(extensionSource, /apiMergedWorkerConfigs\(workerTunnels, setup\)/);
  assert.match(extensionSource, /maxConcurrentGpus: Number\(worker\.maxConcurrentGpus \|\| 1\)/);
});
