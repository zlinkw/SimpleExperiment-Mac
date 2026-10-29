// 真实入口宿主：把生产 dist 里的 syncCodeTargets 与其全部交接/身份/租约方法原样取出来跑，
// 不在这里复制任何生产语义（mapLimited、gate、租约表、身份解析都取生产本体）。
// 只替换外部边界（SimpleSFTP RPC、远端清单、Git、面板通知），便于按事件顺序断言真实调用顺序。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const distSource = fs.readFileSync(path.join(root, "dist/extension/legacy.js"), "utf8");
const Gate = require("../../dist/features/DispatchHandoffGate.js");

function sliceMethod(source, name) {
  const asyncAt = source.indexOf("\n    async " + name + "(");
  const plainAt = source.indexOf("\n    " + name + "(");
  const start = asyncAt >= 0 ? asyncAt + 1 : plainAt + 1;
  assert.ok(start > 0, `missing production method: ${name}`);
  const rest = source.slice(start + name.length + 8);
  const next = rest.search(/\n {4}(?:async )?[A-Za-z_][A-Za-z0-9_]*\([^;]*\) \{/);
  assert.ok(next > 0, `cannot find end of production method: ${name}`);
  return source.slice(start, start + name.length + 8 + next);
}

// 生产的 mapLimited 本体（并发度与补位语义由生产决定，测试不另写一份）。
const mapLimitedStart = distSource.indexOf("async function mapLimited(");
assert.ok(mapLimitedStart > 0, "mapLimited");
const mapLimitedSource = distSource.slice(mapLimitedStart, distSource.indexOf("\n}\n", mapLimitedStart) + 3);

const manifestStart = distSource.indexOf("async function buildLocalCodeManifest(");
const manifestEnd = distSource.indexOf("function isLocalCodeOwnedPath(", manifestStart);
const manifestApi = new Function("fs", "fsNode", "path", "crypto", "LocalCodeManifestCache_1", "PlanCodeScopeHost",
  distSource.slice(manifestStart, manifestEnd) + "\nreturn { buildLocalCodeManifest };")(
  fs.promises, fs, path, crypto, require("../../dist/features/LocalCodeManifestCache.js"),
  require("../../dist/extension/PlanCodeScopeHost.js"));

// 需要在真实宿主里跑的生产方法：缺任何一个都直接失败，不做“缺方法就跳过”的替身。
const METHOD_NAMES = [
  "gateStateLocal", "targetLeaseTableLocal", "boundedPromise",
  "beginCodeUploadHandoffLocal", "endCodeUploadHandoffLocal", "awaitDispatchHandoffSafeLocal",
  "markCodeUploadWorkerReadyLocal", "markCodeUploadWorkerFailedLocal", "noteCodeUploadTargetLocal",
  "dispatchHandoffAllowsWorkerLocal", "dispatchHandoffYieldsRoundLocal", "dispatchHandoffDiagnosticsLocal",
  "recordDispatchHandoffTimeoutLocal", "acquireCodeUploadTargetLeaseLocal", "releaseCodeUploadTargetLeaseLocal",
  "retainCodeUploadTargetLeaseLocal", "releaseRetainedCodeUploadTargetLeaseLocal",
  "markCodeSyncTargetResultLocal", "sftpServerOptions", "sshTransportIdentity",
  "resolveCodeUploadTargetIdentityLocal", "dispatchTargetKeyLocal",
  "pendingCodeUploadUnknownWriteLocal", "resolveCodeUploadUnknownWriteLocal",
  "verifyCodeUploadTargetQuiescentLocal", "codeUploadTargetRowsLocal", "codeUploadCurrentRoundTargetKeysLocal",
  "withCodeUploadRoundWriteLocal", "codeUploadRoundWriteFloorLocal",
  "cancelCodeUploadTargetWriteLocal",
  "codeUploadStaleAgeLocal", "codeUploadStuckOperationLocal", "codeUploadStaleIdentityLocal",
  "codeUploadStaleBindingLocal", "codeUploadStaleLateConsentLocal",
  "noteCodeUploadStaleSuspectsLocal", "collectCodeUploadStaleRecordsLocal", "askCodeUploadStaleOverwriteLocal",
  "recordCodeUploadStaleDecisionLocal", "codeUploadStaleOverwriteLocal", "clearCodeUploadStaleSuspectsLocal",
  "takeoverCodeUploadTargetLocal", "takeoverCodeUploadTargetLockedLocal", "codeUploadBlockedByCurrentBatchLocal",
  "rememberUnknownCodeWriteLocal",
  "syncCodeTargets", "checkRunCodeWithoutUploadLocal", "safeWorkerCodeSyncTargets",
];
const asyncNames = new Set(["syncCodeTargets", "checkRunCodeWithoutUploadLocal", "safeWorkerCodeSyncTargets", "boundedPromise", "acquireCodeUploadTargetLeaseLocal",
  "verifyCodeUploadTargetQuiescentLocal", "cancelCodeUploadTargetWriteLocal", "takeoverCodeUploadTargetLocal",
  "takeoverCodeUploadTargetLockedLocal", "withCodeUploadRoundWriteLocal", "collectCodeUploadStaleRecordsLocal",
  "askCodeUploadStaleOverwriteLocal", "codeUploadStaleLateConsentLocal"]);

function compiled(name) {
  const body = sliceMethod(distSource, name).replace(/^\s{4}/gm, "");
  const prefix = (body.startsWith("async ") || asyncNames.has(name) ? "async function " : "function ") + name + "(";
  return body.replace(new RegExp("^(?:async )?" + name + "\\("), prefix);
}

const statusSliceStart = distSource.indexOf("const NON_SUCCESSFUL_SYNC_STATUSES");
assert.ok(statusSliceStart > 0, "NON_SUCCESSFUL_SYNC_STATUSES");

const createApi = new Function("SyncResolution_1", "CodeSyncDelta_1", "fingerprintFromManifest", "buildLocalCodeManifest",
  "vscode_1", "LocalCodeManifestCache_1", "SafeRequestRetry_1", "DistributedPlanQueue", "workspaceRoot",
  "PlanCodeScopeHost", "ProjectRootMap_1", "DispatchHandoffGate", "SshTransportIdentity_1", `
  function stringField(message, key) { return String((message && message[key]) || ""); }
  function errorMessage(error) { return error && error.message ? error.message : String(error || ""); }
  class UiCommandCancelled extends Error {}
  function isUiCommandCancelled(error) { return error instanceof UiCommandCancelled; }
  ${mapLimitedSource}
  ${distSource.slice(statusSliceStart, distSource.indexOf("function persistedTunnelGatewayConfig", statusSliceStart))}
  function sftpUploadSucceeded(result) { return Boolean(result && result.ok === true); }
  function resultError(result) { return String((result && result.error) || ""); }
  function codeSyncConfirmationLabel(scope) { return scope; }
  const vscode = arguments[4];
  ${METHOD_NAMES.map(compiled).join("\n  ")}
  return { UiCommandCancelled, isUiCommandCancelled, ${METHOD_NAMES.join(", ")} };
`);

function sha(char) { return String(char).repeat(64); }

/**
 * @param options.targets 真实写目标（同一 host+root 即视为同一实际目标）
 * @param options.remote  远端清单替身（对象或按次回调）
 * @param options.upload  upload.workspace / transfers.list 等 RPC 替身
 */
function createRealSyncHost(options = {}) {
  const SyncResolution = require("../../dist/features/SyncResolution.js");
  const CodeSyncDelta = require("../../dist/features/CodeSyncDelta.js");
  const calls = [];
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "real-sync-root-"));
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "train.py"), "same");
  const host = {
    project, calls,
    syncScopeMutationInFlight: false,
    codeSyncInFlight: 0,
    // 生产类字段有初始化器；摘出来的宿主必须自己补上，否则 ++undefined 会让每轮 uploadId 都是 NaN，
    // 两轮同身份会把“上一轮保留的租约”误判成同批兄弟分支。
    codeUploadHandoffSeq: 0,
    localCodeManifestMemo: undefined,
    lastCodeSyncState: {},
    lastCodeSyncStats: {},
    codeSyncWarmProofs: new Map(),
    codeSyncAgentProofs: new Map(),
    dispatchHandoffGate: undefined,
    codeUploadTargetLeases: undefined,
    retainedCodeUploadTargetLeases: undefined,
    codeSyncTargetResults: [],
    // 原生模态框的真实调用记录（标题/是否 modal/正文/按顺序的按钮）与运行事实日志。
    modals: [], facts: [],
    dispatchHandoffTimeoutEvidence: undefined,
    lastWorkerProbes: {},
    lastFullEndpointProbeAt: Date.now(),
    context: { globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), "real-sync-store-")) } },
    stages: [], uploads: [], inventories: [], confirmations: [], profiles: [],
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }),
    targetRootGuard: () => ({ prefixes: [], unknown: false }),
    prepareCodeSyncRootGuards: async targets => {
      const guards = new Map();
      for (const item of targets) guards.set(item, host.targetRootGuard(item));
      return { guards, assertBindingsCurrent: () => {} };
    },
    projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => ({ schemaVersion: 1, plans: [] }),
    readWorkerTaskSnapshot: async workerId => ({ workerId, tasks: [], generatedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 } }),
    projectContextIsCurrent: () => true,
    ensureSftpManagerCommand: async () => {},
    confirmRemoteWriteTargets: async (_label, targets) => { host.confirmations.push(targets.map(row => row.id)); },
    writeSftpManagerServerProfiles: async ids => { host.profiles.push(ids); },
    prepareSftpTargets: async () => {},
    logOperationFact: (line) => { host.facts.push(String(line)); },
    notifyLocalActionStarted: () => {},
    persistProjectCodeSyncState: async () => {},
    postState: () => {},
    markProjectOnboardingComplete: async () => {},
    sftpSharedTargets: () => targets,
    sftpServerOptions: target => ({ id: target.id, host: target.host, user: target.user, port: target.port,
      remotePath: target.remotePath }),
    codeSyncWarmProofKey: (target, rootKey, fingerprint, includePaths, scopePaths) => JSON.stringify({ target: target.id,
      root: rootKey, remotePath: target.remotePath, fingerprint, includePaths, scopePaths,
      statusGeneration: host.lastWorkerProbes[target.id]?.statusGeneration || 0 }),
    planSubmissionManifestKey: (rootKey, includePaths, scopePaths, holds) => JSON.stringify({ root: rootKey, includePaths, scopePaths, holds }),
    rememberCodeSyncWarmProof: key => host.codeSyncWarmProofs.set(key, Date.now() + 300000),
    ensureWorkerCodeSyncProof: async () => undefined,
    verifiedSftpProjectInventory: async request => {
      host.inventories.push(request);
      host.calls.push({ method: "inventory", targetId: request.source?.id });
      const remote = typeof options.remote === "function" ? options.remote(request, host.inventories.length) : (options.remote || { files: {} });
      return remote;
    },
    simpleSftpApiCall: async (method, params) => {
      host.calls.push({ method, targetId: params?.targetId, sourceId: params?.source?.id, remotePath: params?.source?.remotePath });
      if (typeof options.upload === "function") return options.upload(host, method, params);
      if (method === "upload.workspace") return { ok: true, status: "completed" };
      if (method === "transfers.list") return quiescedTransferState();
      // 默认替身只在“没有活动传输”的路径上出现；新流程真去取消时必须由用例自己交出可核对的回执。
      if (method === "transfers.cancel") return { ok: true, transferId: String(params?.transferId || ""),
        operationId: String(params?.operationId || ""), cancelled: true, status: "cancelling", settled: false,
        operationInstanceId: String(params?.operationInstanceId || ""), instanceId: "instance-real-1" };
      throw new Error(`unexpected api ${method}`);
    },
  };
  const targets = options.targets || [
    { id: "worker-a", role: "worker", label: "Worker A", host: "one.example", user: "me", port: 22, remotePath: "/work/proj" },
  ];
  host.targets = targets;
  host.target = targets[0];
  host.workerCodeSyncTargets = () => targets;
  host.lastWorkerProbes = Object.fromEntries(targets.map(row => [row.id, { status: "ok", agentVersion: "agent-1", statusGeneration: 0 }]));
  const vscodeStub = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => (key.endsWith("includePaths") ? ["src"] : fallback) }) },
    Uri: { file: value => ({ fsPath: value }) },
    ProgressLocation: { Notification: 15 },
    window: { setStatusBarMessage() {}, withProgress: async (_options, run) => run({ report: row => host.stages.push(row.message) }),
      // 未确认覆盖的默认答案就是 undefined（等于 Esc/关掉模态框），用例要批准必须自己写明。
      showWarningMessage: async (message, boxOptions, ...buttons) => {
        const record = { message: String(message), modal: boxOptions?.modal === true,
          detail: String(boxOptions?.detail || ""), buttons: buttons.map(String) };
        host.modals.push(record);
        return typeof options.modalAnswer === "function" ? options.modalAnswer(record) : options.modalAnswer;
      },
      showInformationMessage: message => host.calls.push({ method: "notice", message: String(message) }),
      showErrorMessage: message => host.calls.push({ method: "error", message: String(message) }) },
    commands: { executeCommand: async () => ({ ok: true }) },
  };
  const api = createApi(
    SyncResolution, CodeSyncDelta,
    manifest => crypto.createHash("sha256").update(JSON.stringify(Object.keys(manifest).sort().map(key => [key, manifest[key]]))).digest("hex"),
    manifestApi.buildLocalCodeManifest, vscodeStub,
    require("../../dist/features/LocalCodeManifestCache.js"), require("../../dist/core/SafeRequestRetry.js"),
    require("../../dist/features/DistributedPlanQueue.js"), () => project,
    require("../../dist/extension/PlanCodeScopeHost.js"), require("../../dist/features/ProjectRootMap.js"), Gate,
    require("../../dist/tunnel/SshTransportIdentity.js"));
  Object.assign(host, api);
  host.localCodeManifestCacheFile = () => path.join(host.context.globalStorageUri.fsPath, "code-manifest.json");
  return host;
}

/** SimpleSFTP `transfers.list` 的真实形状：写忙投影 + 实时传输表 + 实例身份。 */
function quiescedTransferState(overrides = {}) {
  return { ok: true, instanceId: "instance-real-1", transfers: [], operations: [], settledOperations: [],
    busy: { schemaVersion: 1, observedAt: new Date().toISOString(), instanceId: "instance-real-1", busy: false,
      activeTransferCount: 0, blockingTransferCount: 0, observerTransferCount: 0, uploadOperationCount: 0, uploadOperations: [],
      uploadQueueCount: 0, uploadQueues: { count: 0, keyHashes: [] } }, ...overrides };
}

/** 上一轮传输还挂在本目标上的真实形状（活动传输 + 未终结台账操作，可带实例身份）。 */
function busyTransferState(row = {}, operations = []) {
  const state = quiescedTransferState();
  state.busy.busy = true;
  state.busy.activeTransferCount = 1;
  state.busy.blockingTransferCount = 1;
  state.transfers = [{ id: "t-1", operation: "upload.workspace", host: "one.example", remotePath: "/work/proj",
    status: "running", phase: "uploading", operationId: "op-1", ...row }];
  // 真实台账行形状：id 就是 operationId，且没有顶层 host/remotePath。
  state.operations = operations.map((item) => {
    const operationId = String(item.operationId ?? "op-1");
    return { id: operationId, operationId, operationInstanceId: "instance-real-1", status: "running",
      startedAt: new Date().toISOString(), recovery: null, childCount: 0, ...item };
  });
  return state;
}

/**
 * 只在台账里、没有活动传输行的未终结操作（SimpleSFTP 的 listTransferOperationState 独立返回台账，
 * 不保证每项都有活动 transfer 行）：默认 outcomeUnknown + childCount=1，整体写忙仍为 true。
 * 形状与已安装 0.2.114 一致：`{ id: row.operationId, operationId, operationInstanceId, status, childCount }`，
 * 同时带 id 与 operationId，但没有顶层 host/remotePath。
 */
function ledgerOnlyTransferState(operation = {}) {
  const state = quiescedTransferState();
  const operationId = String(operation.operationId ?? "op-9");
  state.busy.busy = true;
  state.busy.uploadOperationCount = 1;
  state.busy.uploadOperations = [{ operationId, status: "outcomeUnknown" }];
  state.operations = [{ id: operationId, operationId, operationInstanceId: "instance-real-1", status: "outcomeUnknown",
    startedAt: new Date().toISOString(), recovery: null, childCount: 1, ...operation }];
  return state;
}

/**
 * 只有当前上传阶段项（activeUploadOperations 的 `{ id, stage, startedAt }`）：同样没有 host/remotePath，
 * 也没有 status/operationInstanceId，不能因为缺字段就被当成静默漏掉。
 */
function uploadPhaseOnlyState(operation = {}) {
  const state = quiescedTransferState();
  const operationId = String(operation.operationId ?? "op-stage-7");
  state.busy.busy = true;
  state.busy.uploadOperationCount = 1;
  state.busy.uploadOperations = [{ operationId, stage: "acquiring-lease" }];
  state.operations = [{ id: operationId, stage: "acquiring-lease", startedAt: new Date().toISOString(), ...operation }];
  return state;
}

module.exports = { createRealSyncHost, quiescedTransferState, busyTransferState, ledgerOnlyTransferState,
  uploadPhaseOnlyState, sha, distSource, Gate };
