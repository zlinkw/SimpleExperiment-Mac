const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const legacySource = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
const distSource = fs.readFileSync(path.join(root, "dist/extension/legacy.js"), "utf8");

function sliceMethod(source, name) {
  const asyncAt = source.indexOf("\n    async " + name + "(");
  const plainAt = source.indexOf("\n    " + name + "(");
  const start = asyncAt >= 0 ? asyncAt + 1 : plainAt + 1;
  assert.ok(start > 0, name);
  const rest = source.slice(start + name.length + 8);
  const next = rest.search(/\n {4}(?:async )?[A-Za-z_][A-Za-z0-9_]*\([^;]*\) \{/);
  assert.ok(next > 0, name + " end");
  return source.slice(start, start + name.length + 8 + next);
}

function compiled(name) {
  const body = sliceMethod(distSource, name).replace(/^\s{4}/gm, "");
  const asyncNames = new Set(["syncCodeTargets", "ensureHubCodeReadyForPlanCheck", "beginPlanSubmissionProgress", "patchPlanSubmissionProgress", "finishPlanSubmissionProgress"]);
  const replacement = (body.startsWith("async ") || asyncNames.has(name) ? "async function " : "function ") + name + "(";
  return body.replace(new RegExp("^(?:async )?" + name + "\\("), replacement);
}

const manifestStart = distSource.indexOf("async function buildLocalCodeManifest(");
const manifestEnd = distSource.indexOf("function isLocalCodeOwnedPath(", manifestStart);
const manifestFactory = new Function("fs", "fsNode", "path", "crypto", "LocalCodeManifestCache_1", distSource.slice(manifestStart, manifestEnd) + "\nreturn { buildLocalCodeManifest };");
const manifestApi = manifestFactory(require("node:fs").promises, require("node:fs"), path, crypto, require("../../dist/features/LocalCodeManifestCache.js"));

const apiFactory = new Function("SyncResolution_1", "CodeSyncDelta_1", "fingerprintFromManifest", "buildLocalCodeManifest", "vscode_1", "LocalCodeManifestCache_1", "SafeRequestRetry_1", "DistributedPlanQueue", "workspaceRoot", `
  function stringField(message, key) { return String((message && message[key]) || ""); }
  function operationResultPlanFile(body) { return String((body && (body.planFile || body.selectedPlanId || (body.options && body.options.planFile))) || ""); }
  function errorMessage(error) { return error && error.message ? error.message : String(error || ""); }
  class UiCommandCancelled extends Error {}
  function isUiCommandCancelled(error) { return error instanceof UiCommandCancelled; }
  async function mapLimited(items, limit, worker) {
    const out = [];
    for (let index = 0; index < items.length; index += 1) out.push(await worker(items[index], index));
    return out;
  }
  ${distSource.slice(distSource.indexOf("const NON_SUCCESSFUL_SYNC_STATUSES"), distSource.indexOf("function persistedTunnelGatewayConfig", distSource.indexOf("const NON_SUCCESSFUL_SYNC_STATUSES")))}
  function sftpUploadSucceeded(result) { return Boolean(result && result.ok === true); }
  function resultError(result) { return String((result && result.error) || ""); }
  function codeSyncConfirmationLabel(scope) { return scope; }
  const vscode = arguments[4];
  function gitRepositoryHasRemote() { return true; }
  ${compiled("syncCodeTargets")}
  ${compiled("safeWorkerCodeSyncTargets")}
  ${compiled("syncManualWorkerCode")}
  ${compiled("uploadProjectToWorkers")}
  ${compiled("distributeCodeToWorkers")}
  ${compiled("publishToGitHub")}
  ${compiled("reportPlanStage")}
  ${compiled("planSubmissionOperationId")}
  ${compiled("planSubmissionPlanFile")}
  ${compiled("beginPlanSubmissionProgress")}
  ${compiled("patchPlanSubmissionProgress")}
  ${compiled("finishPlanSubmissionProgress")}
  ${compiled("trimPlanSubmissionEpochs")}
  return { syncCodeTargets, safeWorkerCodeSyncTargets, syncManualWorkerCode, uploadProjectToWorkers, distributeCodeToWorkers, publishToGitHub, reportPlanStage, planSubmissionOperationId, planSubmissionPlanFile, beginPlanSubmissionProgress, patchPlanSubmissionProgress, finishPlanSubmissionProgress, trimPlanSubmissionEpochs };
`);

function sha(char) { return char.repeat(64); }

function syncHost(remote) {
  const SyncResolution = require("../../dist/features/SyncResolution.js");
  const CodeSyncDelta = require("../../dist/features/CodeSyncDelta.js");
  const host = {
    syncScopeMutationInFlight: false,
    codeSyncInFlight: 0,
    localCodeManifestMemo: undefined,
    lastCodeSyncState: {},
    lastCodeSyncStats: {},
    codeSyncWarmProofs: new Map(),
    codeSyncAgentProofs: new Map(),
    pendingPlanSubmissionManifest: undefined,
    lastWorkerProbes: { "worker-a": { status: "ok", agentVersion: "agent-1", statusGeneration: 0 } },
    lastFullEndpointProbeAt: Date.now(),
    context: { globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-holds-")) } },
    stages: [],
    inventories: [],
    uploads: [],
    uploadRequests: [],
    notices: [],
    errors: [],
    confirmations: [],
    profiles: [],
    builds: 0,
  };
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-root-"));
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "train.py"), "same");
  host.project = project;
  host.projectTopologyAssessment = () => ({ mode: "worker_pool" });
  host.loadDistributedQueue = async () => ({ schemaVersion: 1, plans: [] });
  host.taskReads = [];
  host.readWorkerTaskSnapshot = async (workerId, options) => {
    host.taskReads.push({ workerId, options });
    return { workerId, tasks: [], generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 } };
  };
  host.projectContextIsCurrent = () => true;
  host.ensureSftpManagerCommand = async () => {};
  host.confirmRemoteWriteTargets = async (_label, targets) => { host.confirmations.push(targets.map(row => row.id)); };
  host.writeSftpManagerServerProfiles = async (ids) => { host.profiles.push(ids); };
  host.prepareSftpTargets = async () => {};
  host.notifyLocalActionStarted = () => {};
  host.githubUpdateToken = async () => "test-token";
  host.primaryGitRepository = async () => ({});
  host.syncToGitHub = async () => { host.githubPublished = true; };
  host.persistProjectCodeSyncState = async () => {};
  host.postState = () => {};
  host.markProjectOnboardingComplete = async () => {};
  host.sftpServerOptions = (target) => ({ id: target.id, host: target.host, user: target.user, port: target.port, remotePath: target.remotePath });
  host.codeSyncWarmProofKey = (target, root, fingerprint, includePaths, scopePaths) => JSON.stringify({ target: target.id, root, remotePath: target.remotePath, fingerprint, includePaths, scopePaths, statusGeneration: host.lastWorkerProbes[target.id]?.statusGeneration || 0 });
  host.planSubmissionManifestKey = (root, includePaths, scopePaths, holds) => JSON.stringify({ root, includePaths, scopePaths, holds });
  host.rememberCodeSyncWarmProof = (key) => host.codeSyncWarmProofs.set(key, Date.now() + 300000);
  host.ensureWorkerCodeSyncProof = async () => undefined;
  host.verifiedSftpProjectInventory = async (request) => {
    host.inventories.push(request);
    return typeof remote === "function" ? remote(request, host.inventories.length) : remote;
  };
  const vscodeStub = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key.endsWith("includePaths") ? ["src"] : fallback }) },
    Uri: { file: (value) => ({ fsPath: value }) },
    ProgressLocation: { Notification: 15 },
    window: { setStatusBarMessage() {}, withProgress: async (_options, run) => run({ report: row => host.stages.push(row.message) }),
      showInformationMessage: text => host.notices.push(text), showErrorMessage: text => host.errors.push(text) },
    commands: { executeCommand: async (_command, payload) => { host.uploads.push(Object.keys(payload.manifest)); host.uploadRequests.push(payload); return { ok: true, status: "completed" }; } },
  };
  const api = apiFactory(
    SyncResolution,
    CodeSyncDelta,
    (manifest) => crypto.createHash("sha256").update(JSON.stringify(Object.keys(manifest).sort().map((key) => [key, manifest[key]]))).digest("hex"),
    manifestApi.buildLocalCodeManifest,
    vscodeStub,
    require("../../dist/features/LocalCodeManifestCache.js"),
    require("../../dist/core/SafeRequestRetry.js"),
    require("../../dist/features/DistributedPlanQueue.js"),
    () => project,
  );
  Object.assign(host, api);
  host.localCodeManifestCacheFile = () => path.join(host.context.globalStorageUri.fsPath, "code-manifest.json");
  host.target = { id: "worker-a", role: "worker", label: "Worker A", host: "worker.example", user: "me", port: 22, remotePath: "/work/proj" };
  host.workerCodeSyncTargets = () => [host.target];
  return host;
}

function mixedWorkers() {
  const host = syncHost({ files: {} });
  const busy = { ...host.target, id: "worker-b", label: "Worker B" };
  host.workerCodeSyncTargets = () => [host.target, busy];
  host.lastCodeSyncState = { fingerprint: sha("b"), workerVersions: { "worker-b": {
    fingerprint: sha("b"), manifestDigest: sha("b"), codeSyncProofId: sha("c"), files: ["old.py"],
  } } };
  host.oldVersion = JSON.stringify(host.lastCodeSyncState.workerVersions["worker-b"]);
  const read = host.readWorkerTaskSnapshot;
  host.readWorkerTaskSnapshot = async (id, options) => {
    const snapshot = await read(id, options);
    if (id === busy.id) snapshot.tasks = [{ status: "running", codeFingerprint: sha("b") }];
    return snapshot;
  };
  return host;
}

test("manual upload touches only the free Worker and accurately reports the held original version", async () => {
  const host = mixedWorkers();
  const result = await host.uploadProjectToWorkers();
  assert.deepEqual(host.uploadRequests.map(row => row.targetId), ["worker-a"]);
  assert.deepEqual(host.confirmations, [["worker-a"]]);
  assert.deepEqual(host.profiles, [["worker-a"]]);
  assert.deepEqual(host.inventories.map(row => row.source.id), ["worker-a"]);
  assert.equal(JSON.stringify(host.lastCodeSyncState.workerVersions["worker-b"]), host.oldVersion);
  assert.deepEqual(result.syncedWorkerIds, ["worker-a"]);
  assert.match(result.message, /已同步 1 台.*待同步 1 台.*Worker B/);
  assert.match(host.lastCodeSyncState.workers, /^待同步 1 台/);
  assert.equal(host.lastCodeSyncState.error, undefined);
  assert.equal(host.errors.length, 0);
  assert.match(host.notices.at(-1), /Worker B/);
  assert.ok(host.taskReads.every(row => row.options.fresh === true));
});

test("all occupied Workers stay pending without writes and can be uploaded after ownership clears", async () => {
  const host = mixedWorkers();
  host.workerCodeSyncTargets = () => [{ ...host.target, id: "worker-b", label: "Worker B" }];
  const held = await host.uploadProjectToWorkers();
  assert.deepEqual(held.syncedWorkerIds, []);
  assert.match(held.message, /已同步 0 台.*待同步 1 台/);
  assert.equal(host.confirmations.length + host.profiles.length + host.inventories.length + host.uploads.length, 0);
  assert.equal(JSON.stringify(host.lastCodeSyncState.workerVersions["worker-b"]), host.oldVersion);
  assert.equal(host.codeSyncInFlight, 0);
  host.readWorkerTaskSnapshot = async workerId => ({ workerId, tasks: [], generatedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 } });
  const retried = await host.uploadProjectToWorkers();
  assert.deepEqual(retried.syncedWorkerIds, ["worker-b"]);
  assert.equal(retried.heldWorkers.length, 0);
  assert.deepEqual(host.uploadRequests.map(row => row.targetId), ["worker-b"]);
  assert.match(host.lastCodeSyncState.workers, /^已同步 1 台$/);
  assert.notEqual(JSON.stringify(host.lastCodeSyncState.workerVersions["worker-b"]), host.oldVersion);
});

test("GitHub publish reports partial or pending Worker uploads as such and preserves real transfer errors", async () => {
  const host = mixedWorkers();
  await host.publishToGitHub("publish-test");
  assert.equal(host.githubPublished, true);
  assert.equal(host.errors.length, 0);
  assert.match(host.notices.at(-1), /GitHub.*已同步 1 台.*待同步 1 台/);
  assert.doesNotMatch(host.notices.at(-1), /所有 Worker/);
  const allHeld = mixedWorkers();
  allHeld.workerCodeSyncTargets = () => [{ ...allHeld.target, id: "worker-b", label: "Worker B" }];
  await allHeld.publishToGitHub("publish-test");
  assert.equal(allHeld.errors.length, 0);
  assert.match(allHeld.notices.at(-1), /GitHub.*已同步 0 台.*待同步 1 台/);
  assert.ok(allHeld.stages.every(text => text !== "全部完成"));
  const failed = mixedWorkers();
  failed.verifiedSftpProjectInventory = async () => { throw new Error("permission denied"); };
  await assert.rejects(failed.publishToGitHub("publish-test"), /permission denied/);
  assert.match(failed.errors.at(-1), /GitHub 已发布.*上传失败/);
  assert.equal(failed.notices.length, 0);
  assert.equal(JSON.stringify(failed.lastCodeSyncState.workerVersions["worker-b"]), failed.oldVersion);
});

test("manual distribute skips locked Workers but internal artifact/file coordination keeps strict protection", async () => {
  const host = mixedWorkers();
  await host.distributeCodeToWorkers();
  assert.deepEqual(host.uploadRequests.map(row => row.targetId), ["worker-a"]);
  assert.match(host.notices.at(-1), /已同步 1 台.*待同步 1 台/);
  const strict = mixedWorkers();
  await assert.rejects(strict.syncCodeTargets(strict.workerCodeSyncTargets(), "workers", { hashCompare: true }), /未覆盖运行中代码/);
  assert.equal(strict.uploads.length + strict.confirmations.length + strict.inventories.length, 0);
});

test("manual skipping works for both topologies while stale or failed probes keep their Worker protected", async () => {
  for (const snapshotChange of [{ error: "offline" }, { generatedAt: "2000-01-01T00:00:00Z" }, { tasks: [{ status: "unknown" }] }]) {
    const host = mixedWorkers(), read = host.readWorkerTaskSnapshot;
    host.projectTopologyAssessment = () => ({ mode: "hub_worker", hubAllowed: true });
    host.readWorkerTaskSnapshot = async (id, options) => {
      const row = await read(id, options);
      return id === "worker-b" ? { ...row, ...snapshotChange } : row;
    };
    const result = await host.uploadProjectToWorkers();
    assert.deepEqual(result.syncedWorkerIds, ["worker-a"]);
    assert.deepEqual(host.uploadRequests.map(row => row.targetId), ["worker-a"]);
    assert.equal(result.heldWorkers.length, 1);
    assert.equal(JSON.stringify(host.lastCodeSyncState.workerVersions["worker-b"]), host.oldVersion);
  }
});

test("warm unchanged reuses stat hashes and Extension Host proof skips repeat remote inventory", async () => {
  const host = syncHost({
    files: { "src/train.py": { size: 4, sha256: crypto.createHash("sha256").update("same").digest("hex") } },
  });
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true, progressReport: (text) => host.stages.push(text) });
  assert.equal(host.lastCodeSyncStats.hashed, 1);
  assert.equal(host.lastCodeSyncStats.cacheWriteSkipped, 0);
  assert.equal(host.uploads.length, 0);
  assert.equal(host.inventories.length, 1);
  host.stages.length = 0;
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true, progressReport: (text) => host.stages.push(text) });
  assert.equal(host.inventories.length, 1);
  assert.equal(host.lastCodeSyncStats.hashed, 0);
  assert.ok(host.lastCodeSyncStats.hashReused >= 1);
  assert.equal(host.lastCodeSyncStats.cacheWriteSkipped, 1);
  assert.equal(host.uploads.length, 0);
  assert.match(host.stages.join("\n"), /缓存未改写/);
  assert.match(host.stages.join("\n"), /跳过递归清单/);
  await host.syncCodeTargets([{ ...host.target, remotePath: "/work/other" }], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  assert.equal(host.inventories.length, 2, "remote path changes invalidate the warm proof");
  host.lastFullEndpointProbeAt = Date.now() - 120_000;
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  assert.equal(host.inventories.length, 2, "global endpoint probe age alone cannot invalidate a five-minute per-Worker proof");
  host.lastWorkerProbes["worker-a"].statusGeneration += 1;
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  assert.equal(host.inventories.length, 3, "a Worker status generation change invalidates only that Worker's warm proof");
});

test("warm code proof still refreshes dynamic task ownership before every potential code write", async () => {
  const host = syncHost({ files: { "src/train.py": { size: 4, sha256: crypto.createHash("sha256").update("same").digest("hex") } } });
  await host.syncCodeTargets([host.target], "run", { projectContext: { root: host.project }, hashCompare: true });
  host.readWorkerTaskSnapshot = async workerId => ({ workerId, tasks: [{ status: "running", codeFingerprint: "another-code" }],
    generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), capabilities: { durablePlanQueue: true, schemaVersion: 1 } });
  await assert.rejects(host.syncCodeTargets([host.target], "run", { projectContext: { root: host.project }, hashCompare: true }), /未覆盖运行中代码/);
  assert.equal(host.uploads.length, 0);
  assert.equal(host.codeSyncInFlight, 0);
});

test("run code sync consumes the current Plan submission manifest once", async () => {
  const digest = crypto.createHash("sha256").update("same").digest("hex");
  const host = syncHost({ files: { "src/train.py": { size: 4, sha256: digest } } });
  const manifest = { "src/train.py": { size: 4, sha256: digest } };
  host.pendingPlanSubmissionManifest = { key: host.planSubmissionManifestKey(host.project, ["src"], undefined, {}),
    manifest, stats: { hashed: 0, reused: 1, cacheWriteSkipped: 1 }, fingerprint: "submission-fingerprint", expiresAt: Date.now() + 5000 };
  await host.syncCodeTargets([host.target], "run", { projectContext: { root: host.project }, hashCompare: true });
  assert.equal(host.pendingPlanSubmissionManifest, undefined, "a matching one-run manifest is consumed");
  assert.equal(host.lastCodeSyncStats.hashReused, 1);
});

test("a changed file is hashed and uploaded, and a new file is not hidden by the previous listing", async () => {
  const digest = crypto.createHash("sha256").update("same").digest("hex");
  const host = syncHost({ files: { "src/train.py": { size: 4, sha256: digest } } });
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  const previous = fs.statSync(path.join(host.project, "src", "train.py"));
  const nextTime = new Date(previous.mtimeMs + 2000);
  fs.writeFileSync(path.join(host.project, "src", "train.py"), "edit");
  fs.utimesSync(path.join(host.project, "src", "train.py"), nextTime, nextTime);
  fs.writeFileSync(path.join(host.project, "src", "new.py"), "new");
  host.verifiedSftpProjectInventory = async (request) => {
    host.inventories.push(request);
    return { files: { "src/train.py": { size: 4, sha256: digest } } };
  };
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  assert.ok(host.lastCodeSyncStats.hashed >= 1);
  assert.equal(host.lastCodeSyncStats.inventoryCalls, 1);
  assert.ok(host.uploads.at(-1).includes("src/train.py"));
  assert.ok(host.uploads.at(-1).includes("src/new.py"));
});

test("a remote inventory failure does not upload and the next check reads inventory again", async () => {
  const digest = crypto.createHash("sha256").update("same").digest("hex");
  const host = syncHost({ files: { "src/train.py": { size: 4, sha256: digest } } });
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  host.codeSyncWarmProofs.clear();
  host.verifiedSftpProjectInventory = async () => { throw new Error("inventory down"); };
  await assert.rejects(() => host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true }), /inventory down/);
  assert.equal(host.uploads.length, 0);
  host.verifiedSftpProjectInventory = async (request) => {
    host.inventories.push(request);
    assert.equal(request.knownGeneration, undefined);
    return { files: { "src/train.py": { size: 4, sha256: digest } } };
  };
  await host.syncCodeTargets([host.target], "plan-check", { projectContext: { root: host.project }, hashCompare: true });
  assert.equal(host.inventories.length, 2);
  assert.equal(host.uploads.length, 0);
});

function commandRunner() {
  const start = legacySource.indexOf("        const action = actionCommandMap[command];");
  const end = legacySource.indexOf("        this.throwIfTerminalActionFailure(command, action, resultStatus(finalResult), finalResult);", start);
  const body = legacySource.slice(start, end).replace(/: any\[\]/g, "").replace(/: any/g, "").replace(/ as any/g, "").replace(/<string\[\]>/g, "");
  return new Function("PLAN_SUBMISSION_COMMANDS", "PLAN_PREFLIGHT_COMMANDS", "PLAN_SCHEDULER_COMMANDS", "LENIENT_RUN", "operationResultPlanFile", "stringField", "stringArrayField", "uniqueStrings", "usableSelectionKey", "resultStatus", "planCheckAccepted", "remoteActionPendingStatus", "stringFromRecord", "isUiCommandRemotePending", "actionCommandMap", "assertSingleProjectWorkspace", "pluginProjectAdapterRules", "workspaceRoot", "directWorkerActionMap", "WORKER_ACTION_CONFIRM_COMMANDS", "NO_HUB_RESULT_CONFIRM_COMMANDS", "TUNNEL_ACTION_CONFIRM_COMMANDS", "IMMEDIATE_RESULT_SUMMARY_REFRESH_COMMANDS", "RESULT_PARSE_COMMANDS", "actionAffectsResultsSummary", "capabilityForUiCommand", `
    return async function(command, message) { ${body}
      this.throwIfTerminalActionFailure(command, action, resultStatus(finalResult), finalResult);
    };
  `)(new Set(["runPlan"]), new Set(["validatePlan", "dryRunPlan"]), new Set(["validatePlan", "dryRunPlan", "runPlan"]), false,
    (record) => String((record && (record.planFile || (record.options && record.options.planFile))) || ""),
    (message, key) => String((message && message[key]) || ""),
    () => [], (values) => [...new Set(values || [])], (value) => String(value || ""),
    (result) => result && (result.status || result.state),
    (result) => Boolean(result && result.ok === true && result.status === "completed" && !result.error),
    (status) => ["submitted", "pending", "accepted", "queued", "running"].includes(String(status || "")),
    (record, keys) => keys.map((key) => record && record[key]).find(Boolean) || "",
    (error) => Boolean(error && error.remotePending),
    { validatePlan: "validate-plan", dryRunPlan: "dry-run-plan" }, () => {}, () => ({}), () => root, {}, new Set(), new Set(), new Set(), new Set(), new Set(), () => false, () => []);
}

test("validate and dry-run publish their own stages and a failed result stays failed", async () => {
  const run = commandRunner();
  const api = apiFactory({}, {}, () => "", manifestApi.buildLocalCodeManifest, { window: { setStatusBarMessage() {} } }, {}, require("../../dist/core/SafeRequestRetry.js"));
  const calls = [];
  const host = {
    localOperations: {}, distributedSubmissionEpochs: new Map(), stages: [], localPlanMetadata: { detectedProject: {} },
    actionBody: (item) => ({ planFile: item.planFile, options: {} }),
    refreshLocalPlanMetadataForAction: async () => {},
    stampPlanRevision: () => {},
    assertPlanLocalConfigFiles: async () => {},
    ensureWorkerPoolPlanTarget: async () => {},
    assertPlanSchedulerAgentReady: () => {},
    ensureHubCodeReadyForPlanCheck: async (_body, report) => report("正在核对本地目录状态…"),
    postNoHubResultAction: async () => undefined,
    throwIfRemoteActionPending: () => {},
    throwIfTerminalActionFailure: (_command, _action, status) => { if (String(status || "") === "failed") throw new Error("plan rejected"); },
    resultStatus: (result) => result && (result.status || result.state),
    planCheckAccepted: (result) => Boolean(result && result.ok === true && result.status === "completed" && !result.error),
    postPlanSchedulerAction: async (action) => { calls.push(action); return action === "validate-plan" ? { ok: true, status: "completed" } : { ok: false, status: "failed", error: "plan rejected" }; },
    ...api,
    postUiCommandStatus(id, status, command, message) { this.stages.push({ id, status, command, message }); },
    postState() {},
    markLocalOperationsDirty() {},
    syncProjectAdapterRulesToAgents: async () => [],
    assertRetryPlanContext() {},
    ensureManualStopReason: async () => {},
    resolveWorkerEndpointId: () => "",
    planSchedulerWorkerId: () => "worker-a",
    waitForOperationTerminalResult: async (_action, result) => result,
  };
  await run.call(host, "validatePlan", { command: "validatePlan", clientActionId: "click-ok", planFile: "plans/a.yaml" });
  await assert.rejects(() => run.call(host, "dryRunPlan", { command: "dryRunPlan", clientActionId: "click-fail", planFile: "plans/a.yaml" }), /plan rejected/);
  assert.deepEqual(calls, ["validate-plan", "dry-run-plan"]);
  assert.equal(host.localOperations["plan-submit-click-ok"].status, "succeeded");
  assert.equal(host.localOperations["plan-submit-click-fail"].status, "failed");
  assert.match(host.stages.map((row) => row.message).join("\n"), /已收到校验/);
  assert.match(host.stages.map((row) => row.message).join("\n"), /已收到预演/);
});

test("a submitted validate stays queued with its operation id until the real terminal result", async () => {
  const run = commandRunner();
  const api = apiFactory({}, {}, () => "", manifestApi.buildLocalCodeManifest, { window: { setStatusBarMessage() {} } }, {}, require("../../dist/core/SafeRequestRetry.js"));
  class RemotePending extends Error { constructor(message) { super(message); this.remotePending = true; } }
  const host = {
    localOperations: {}, distributedSubmissionEpochs: new Map(), stages: [], localPlanMetadata: { detectedProject: {} },
    actionBody: (item) => ({ planFile: item.planFile, options: {} }),
    refreshLocalPlanMetadataForAction: async () => {},
    stampPlanRevision: () => {},
    assertPlanLocalConfigFiles: async () => {},
    ensureWorkerPoolPlanTarget: async () => {},
    assertPlanSchedulerAgentReady: () => {},
    ensureHubCodeReadyForPlanCheck: async () => {},
    postNoHubResultAction: async () => undefined,
    throwIfRemoteActionPending: (_command, _action, result) => { if (result.status === "submitted") throw new RemotePending("still submitted"); },
    throwIfTerminalActionFailure: () => {},
    postPlanSchedulerAction: async () => ({ ok: true, status: "submitted", operationId: "op-validate-1" }),
    waitForOperationTerminalResult: async () => { throw new RemotePending("bounded wait elapsed"); },
    planSchedulerWorkerId: () => "worker-a",
    ...api,
    postUiCommandStatus(_id, status, command, message) { this.stages.push({ status, command, message }); },
    postState() {},
    markLocalOperationsDirty() {},
    syncProjectAdapterRulesToAgents: async () => [],
    assertRetryPlanContext() {},
    ensureManualStopReason: async () => {},
    resolveWorkerEndpointId: () => "",
  };
  await assert.rejects(() => run.call(host, "validatePlan", { command: "validatePlan", clientActionId: "click-pending", planFile: "plans/a.yaml" }), /bounded wait elapsed/);
  const row = host.localOperations["plan-submit-click-pending"];
  assert.equal(row.status, "queued");
  assert.match(row.message, /operationId=op-validate-1/);
  assert.match(row.message, /未标记完成或失败/);
  assert.notEqual(row.status, "failed");
  assert.notEqual(row.status, "succeeded");
  assert.match(host.stages.map((item) => item.message).join("\n"), /正在等待 Agent 校验终态/);
});

test("Plan preflight separates validate submit, terminal wait, and Agent runtime", async () => {
  const durationSource = distSource.match(/^function remoteOperationDurationMs\([\s\S]*?^\}/m)?.[0];
  assert.ok(durationSource, "missing production remote operation duration helper");
  const remoteOperationDurationMs = new Function(`${durationSource}\nreturn remoteOperationDurationMs;`)();
  const preflight = new Function("remoteActionPendingStatus", "resultStatus", "planCheckAccepted",
    "planValidationFromResult", "DistributedPlanQueue", "workspaceRoot", "isUiCommandCancelled",
    "isUiCommandRemotePending", "errorMessage", "actionErrorSuggestion", "vscode", "remoteOperationDurationMs",
    `${compiled("runPlanPreflight")}\nreturn runPlanPreflight;`)(
      (status) => ["submitted", "pending", "accepted", "queued", "running"].includes(String(status || "")),
      (result) => result?.status || result?.state,
      (result) => result?.ok === true && result?.status === "completed" && !result?.error,
      () => ({}), {}, () => "C:/project", () => false, () => false, (error) => error.message, () => "check the Agent",
      { window: { showWarningMessage: async () => undefined } }, remoteOperationDurationMs);
  const timings = {};
  const host = {
    assertActionAuthorityCurrent() {},
    planSchedulerWorkerId: () => "worker-a",
    enabledWorkerConfigs: () => [],
    distributedPlanEligible: () => false,
    cachedPlanValidation: () => undefined,
    postPlanSchedulerAction: async (action) => action === "validate-plan"
      ? { status: "submitted", operationId: "validate-op" }
      : { ok: true, status: "completed" },
    waitForOperationTerminalResult: async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return { ok: true, status: "completed", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:00.400Z" };
    },
  };
  const result = await preflight.call(host, { planFile: "plans/a.yaml" }, "test", {
    recordTiming: (key, ms) => { timings[key] = ms; },
  });
  assert.equal(result.status, "completed");
  assert.ok(timings.validateSubmitMs >= 0);
  assert.ok(timings.validateTerminalWaitMs >= 5);
  assert.equal(timings.validateAgentDurationMs, 400);
});

test("warm local listing does not add a second stat and keeps the unchanged cache write skipped", async () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "plan-manifest-bench-"));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "plan-manifest-bench-cache-"));
  const fsPromises = require("node:fs/promises");
  const realStat = fsPromises.stat;
  let stats = 0;
  fsPromises.stat = async (...args) => { stats += 1; return realStat(...args); };
  try {
    for (let index = 0; index < 40; index += 1) {
      const dir = path.join(tree, "src", `group-${index % 4}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `file-${index}.py`), `print(${index})\n`);
    }
    const cacheFile = path.join(storage, "manifest.json");
    const coldStarted = process.hrtime.bigint();
    const cold = await manifestApi.buildLocalCodeManifest(tree, [], undefined, { cacheFile });
    const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1e6;
    const coldStats = stats;
    stats = 0;
    const warmStarted = process.hrtime.bigint();
    const warm = await manifestApi.buildLocalCodeManifest(tree, [], undefined, { cacheFile });
    const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1e6;
    assert.equal(cold.stats.hashed, 40);
    assert.equal(warm.stats.hashed, 0);
    assert.equal(warm.stats.reused, 40);
    assert.equal(warm.stats.cacheWriteSkipped, 1);
    assert.equal(stats, 40);
    assert.ok(coldStats >= 40);
    assert.ok(warmMs <= Math.max(coldMs * 2, coldMs + 250));
    assert.equal(Object.keys(warm).length, Object.keys(cold).length);
  } finally {
    fsPromises.stat = realStat;
  }
});

test("plan command status stays pending past 45 and 150 seconds until the real result", async () => {
  const body = sliceMethod(distSource, "withUiCommandStatus").replace(/^\s{4}/gm, "").replace(/^async withUiCommandStatus\(/, "async function withUiCommandStatus(");
  const watchdog = sliceMethod(distSource, "uiCommandWatchdogMs").replace(/^\s{4}/gm, "").replace(/^uiCommandWatchdogMs\(/, "function uiCommandWatchdogMs(");
  const runner = new Function("errorMessage", "localCommandReleasesAfterTrigger", "isUiCommandRemotePending", "isUiCommandCancelled", "PLAN_SUBMISSION_COMMANDS", "PLAN_PREFLIGHT_COMMANDS", "OperationOutcome_1", `
    ${watchdog}
    ${body}
    return { withUiCommandStatus, uiCommandWatchdogMs };
  `)((error) => error.message, () => false, () => false, () => false, new Set(["runPlan"]), new Set(["validatePlan", "dryRunPlan"]), require("../../dist/core/OperationOutcome.js"));
  assert.equal(runner.uiCommandWatchdogMs("validatePlan"), 0);
  assert.equal(runner.uiCommandWatchdogMs("runPlan"), 0);
  const statuses = [];
  let resolveWork;
  const host = {
    uiCommandWatchdogMs: runner.uiCommandWatchdogMs,
    postUiCommandStatus(_id, status, command, message) { statuses.push({ status, command, message }); },
    finishPlanSubmissionProgress() { throw new Error("plan progress must stay open"); },
    recordActionError() {},
    postState() {},
  };
  const pending = runner.withUiCommandStatus.call(host, "click-slow", "runPlan", { clientActionId: "click-slow" }, () => new Promise((resolve) => { resolveWork = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(statuses.map((row) => row.status), ["running"]);
  resolveWork();
  await pending;
  assert.equal(statuses.at(-1).status, "completed");
  assert.equal(statuses.some((row) => row.status === "stalled"), false);

  const panel = require("../../dist/ui/PanelHtml.legacy.js").renderPanelHtml();
  const script = panel.slice(panel.indexOf("<script"));
  const handlerStart = script.indexOf("function handleUiCommandStatus");
  const handlerEnd = script.indexOf("function submittedCommandTarget");
  const sandbox = {
    pendingActions: { plan: { command: "runPlan", pendingKey: "plan", clientActionId: "click-slow", startedAt: Date.now() - 151000, status: "running", message: "正在比对远端哈希…" } },
    pendingActionsById: {},
    pendingButtonKeys: new Set(["plan"]),
    pendingActionTimeouts: { "click-slow": 1 },
    cleared: false,
    isTerminalUiStatus(status) { return ["completed", "failed", "cancelled", "stalled"].includes(String(status)); },
    renderCommandPhaseLine() {},
    clearPendingActionTimeout() { sandbox.cleared = true; },
    clearButtonsForPending() { sandbox.buttonsCleared = true; },
    refreshTerminalUi() {},
    applyPendingButtonStates() {},
    clearConfigDraftsForCommand() {},
    showToast() {},
    submittedCommandTarget() { return null; },
    isConfigSaveCommand() { return false; },
    lastState: null,
  };
  sandbox.pendingActionsById["click-slow"] = sandbox.pendingActions.plan;
  vm.createContext(sandbox);
  vm.runInContext(script.slice(handlerStart, handlerEnd), sandbox);
  sandbox.handleUiCommandStatus({ clientActionId: "click-slow", command: "runPlan", status: "running", message: "正在比对远端哈希…（已等待 151 秒）" });
  assert.equal(sandbox.pendingActions.plan.status, "running");
  assert.equal(sandbox.pendingButtonKeys.has("plan"), true);
  assert.equal(sandbox.cleared, false);
  sandbox.handleUiCommandStatus({ clientActionId: "click-slow", command: "runPlan", status: "failed", message: "plan rejected" });
  assert.equal(sandbox.pendingActions.plan, undefined);
  assert.equal(sandbox.cleared, true);
});

test("rendered plan phase stays locked after 45 seconds and after the backend limit", () => {
  const panel = require("../../dist/ui/PanelHtml.legacy.js");
  const html = panel.renderPanelHtml();
  const script = html.slice(html.indexOf("<script"));
  const start = script.indexOf("function planPhaseCommand");
  const end = script.indexOf("function renderCommandPhaseLine");
  const tickStart = script.indexOf("pendingActionTimeouts[clientActionId] = setInterval(() => {");
  const tickEnd = script.indexOf("}, 1000);", tickStart);
  const clearFn = script.indexOf("function clearPendingActionTimeout");
  const clearFnEnd = script.indexOf("function clearButtonsForPending");
  const clearStart = script.indexOf("function clearCompletedPendingButtons");
  const clearEnd = script.indexOf("function setButtonLoading");
  assert.ok(start > 0 && tickStart > 0 && clearStart > 0);
  const sandbox = {
    pendingActions: {},
    pendingActionsById: {},
    pendingButtonKeys: new Set(),
    pendingActionTimeouts: {},
    lines: [],
    ticks: [],
    toasts: [],
    setInterval(fn) { sandbox.ticks.push(fn); return sandbox.ticks.length; },
    clearInterval() {},
    clearTimeout() {},
    renderCommandPhaseLine() { sandbox.lines.push(sandbox.pendingActionsById.click.message); },
    showToast(text) { sandbox.toasts.push(text); },
    isTerminalUiStatus(status) { return ["completed", "failed", "cancelled", "stalled"].includes(String(status)); },
    operationRowsForState: () => [],
    commandActionName: (command) => command,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${script.slice(start, end)}\n${script.slice(clearFn, clearFnEnd)}\n${script.slice(clearStart, clearEnd)}
    pendingActions.plan = { command: "validatePlan", pendingKey: "plan", clientActionId: "click", startedAt: Date.now() - 46000, status: "running", message: "正在核对本地目录状态…" };
    pendingActionsById.click = pendingActions.plan;
    const clientActionId = "click";
    const pendingKey = "plan";
    const command = "validatePlan";
    const phaseLimit = planPhaseCommand(command) ? 1 : 0;
    ${script.slice(tickStart, tickEnd + "}, 1000);".length)}
  `, sandbox);
  sandbox.ticks.at(-1)();
  assert.match(sandbox.pendingActionsById.click.message, /已等待 46 秒/);
  assert.equal(sandbox.pendingActions.plan.clientActionId, "click");
  sandbox.pendingActions.plan.startedAt = Date.now() - 151000;
  sandbox.ticks.at(-1)();
  assert.match(sandbox.pendingActionsById.click.message, /已等待 2 分 31 秒/);
  assert.equal(sandbox.pendingButtonKeys.has("plan") || sandbox.pendingActions.plan, sandbox.pendingActions.plan);
  sandbox.clearCompletedPendingButtons = sandbox.clearCompletedPendingButtons;
  vm.runInContext("clearCompletedPendingButtons({});", sandbox);
  assert.equal(sandbox.pendingActions.plan.clientActionId, "click");
  sandbox.pendingActionsById.click.status = "completed";
  sandbox.ticks.at(-1)();
  assert.equal(sandbox.pendingActionTimeouts.click, undefined);
});
