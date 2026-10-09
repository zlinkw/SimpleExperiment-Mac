const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const queue = require("../../dist/features/DistributedPlanQueue.js");
const delta = require("../../dist/features/CodeSyncDelta.js");
const { MultiEndpointRealtimeClient } = require("../../dist/tunnel/MultiEndpointRealtimeClient.legacy.js");
const extension = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(root, "src/ui/PanelHtml.legacy.ts"), "utf8");
const renderedPanel = require("../../dist/ui/PanelHtml.legacy.js").renderPanelHtml();

test("completed jobs from a prior distributed run are identified by Plan and job identity", () => {
  const stored = { schemaVersion: 1, plans: [
    { id: "old", planFile: "experiments/plans/comparison/concatenation.yaml", revision: "r1", codeFingerprint: "abc", enqueuedAt: "2026-01-01",
      jobs: [
        { index: 0, case: "bus", seed: 42, outputDir: "work_dirs/bus/attempts/old", attempt: 1, status: "completed" },
        { index: 1, case: "bus", seed: 43, outputDir: "work_dirs/bus43/attempts/old", attempt: 1, status: "failed" },
      ] },
    { id: "other", planFile: "experiments/plans/comparison/other.yaml", revision: "r1", codeFingerprint: "abc", enqueuedAt: "2026-01-02",
      jobs: [{ index: 0, case: "bus", seed: 42, outputDir: "other/attempts/old", attempt: 1, status: "completed" }] },
  ] };
  assert.deepEqual(queue.completedJobOutputs(stored, "./experiments/plans/comparison/concatenation.yaml", [
    { index: 0, case: "bus", seed: 42 }, { index: 1, case: "bus", seed: 43 },
  ]), [{ index: 0, case: "bus", seed: 42, output_dir: "work_dirs/bus/attempts/old" }]);
  const selected = [{ index: 1, case: "bus", seed: 43, outputDir: "work_dirs/bus43/attempts/new" }];
  const next = queue.enqueuePlan(stored, { planFile: "experiments/plans/comparison/concatenation.yaml",
    revision: "r1", codeFingerprint: "abc", overwriteExisting: false, jobs: selected }, "new");
  assert.equal(next.plans.at(-1).jobs.length, 1);
  assert.equal(next.plans.at(-1).jobs[0].seed, 43);
});

test("distributed submit confirms prior outputs before enqueue and skips only chosen jobs", () => {
  const submit = extension.slice(extension.indexOf("    async finishDistributedPlanSubmission("), extension.indexOf("    async deferDistributedPlan("));
  assert.match(submit, /confirmDistributedPlanExistingOutputs\(plan, body, preflightOk\)/);
  assert.ok(submit.indexOf("confirmDistributedPlanExistingOutputs(plan, body, preflightOk)") < submit.indexOf("enqueueDistributedPlan(body, preflightOk, false"));
  const enqueue = extension.slice(extension.indexOf("async enqueueDistributedPlan("), extension.indexOf("async tickDistributedQueue("));
  assert.match(enqueue, /distributedSkipJobIndices/);
  assert.match(enqueue, /selectedJobs = validation\.jobs\.filter/);
  assert.match(enqueue, /if \(!selectedJobs\.length\)/);
  assert.match(enqueue, /existingOutputChoice === undefined/);
  assert.match(enqueue, /历史产物处理方式未确认/);
  assert.doesNotMatch(extension, /overwriteExisting !== true\) body\.distributedSkipJobIndices/);
  const historyConfirm = extension.slice(extension.indexOf("async confirmDistributedPlanExistingOutputs("), extension.indexOf("async confirmPlanExistingOutputs("));
  assert.match(historyConfirm, /confirmPlanExistingOutputsFromValidation\(plan, body/);
  assert.doesNotMatch(historyConfirm, /const checked = \{ \.\.\.validated/);
  assert.match(enqueue, /this\.postState\(\)/);
  const send = extension.slice(extension.indexOf("async sendDistributedJob("), extension.indexOf("async tickDistributedQueueCore("));
  assert.match(send, /overwriteExisting: plan\.overwriteExisting === true/);
});

test("runPlan uses one history-choice modal and no overwrite bypass checkbox", () => {
  const submitStart = extension.indexOf("if (PLAN_SUBMISSION_COMMANDS.has(command)) {");
  const submitEnd = extension.indexOf("const danger = command === \"deleteArtifacts\"", submitStart);
  const submit = extension.slice(submitStart, submitEnd);
  assert.match(submit, /if \(command !== "runPlan"\)\s+await this\.confirmPlanRunSubmission/);
  assert.ok(submit.indexOf("await this.assertPlanNotAlreadyActive") < submit.indexOf("await this.confirmPlanRunSubmission"));
  assert.match(submit, /await this\.confirmPlanExistingOutputs\(plan, body, preflightOk\)/);
  assert.doesNotMatch(panel, /data-command="runPlan"[^>]*data-confirm="true"/);
  assert.doesNotMatch(panel, /overwriteExistingToggle|data-overwrite-toggle/);
});

test("publish reports each pre-upload stage and transfers only changed files", () => {
  const publish = extension.slice(extension.indexOf("async publishToGitHub("), extension.indexOf("async overwriteFromGitHub("));
  assert.match(publish, /GitHub 已完成，正在准备 Worker 上传…/);
  assert.doesNotMatch(publish, /开始上传到 Worker/);
  const upload = extension.slice(extension.indexOf("async uploadProjectToWorkers("), extension.indexOf("async distributeCodeToWorkers("));
  assert.match(upload, /正在准备 SFTP 目标…/);
  assert.match(upload, /开始核对本地代码清单/);
  assert.match(upload, /hashCompare: true/);
  const sync = extension.slice(extension.indexOf("async syncCodeTargets("), extension.indexOf("async inspectCodeSyncTarget("));
  const localAt = sync.indexOf("正在建立本地代码清单并核对文件哈希");
  const remoteAt = sync.indexOf("正在比对");
  const transferAt = sync.indexOf("正在传输");
  const uploadAt = sync.indexOf('executeCommand("simpleSftp.uploadWorkspace"');
  assert.ok(localAt >= 0 && remoteAt > localAt && transferAt > remoteAt && uploadAt > transferAt);
  assert.match(sync, /缓存命中 \$\{stats\.reused\}，重新哈希 \$\{stats\.hashed\}/);
  assert.match(sync, /个未变化文件不传输/);
  assert.match(sync, /if \(!Object\.keys\(uploadManifest\)\.length\)/);
  assert.ok(sync.indexOf("if (!Object.keys(uploadManifest).length)") < uploadAt);
});

test("publish upload compares complete remote hashes and transfers only changed files", () => {
  const local = {
    "models/a.py": { sha256: "A".repeat(64), size: 10 },
    "models/b.py": { sha256: "B".repeat(64), size: 11 },
    "configs/new.yaml": { sha256: "C".repeat(64), size: 12 },
  };
  const remote = delta.inventoryFilesByPath({ files: [
    { path: "models/a.py", sha256: "a".repeat(64), size: 10 },
    { path: "models/b.py", sha256: "d".repeat(64), size: 11 },
  ] });
  assert.deepEqual(Object.keys(delta.changedManifestFiles(local, remote)), ["models/b.py", "configs/new.yaml"]);
  assert.deepEqual(delta.changedManifestFiles(local, local), {});
  assert.throws(() => delta.inventoryFilesByPath({}), /清单未返回/);
  const upload = extension.slice(extension.indexOf("async uploadProjectToWorkers("), extension.indexOf("async distributeCodeToWorkers("));
  assert.match(upload, /hashCompare: true/);
  const sync = extension.slice(extension.indexOf("async syncCodeTargets("), extension.indexOf("async inspectCodeSyncTarget("));
  assert.match(sync, /verifiedSftpProjectInventory/);
  assert.match(sync, /const inventoryScopePaths = \[\.\.\.new Set\(Object\.keys\(manifest\)\.map/);
  assert.equal((sync.match(/scopePaths: inventoryScopePaths/g) || []).length, 1);
  assert.doesNotMatch(sync, /ensureRemoteAgentVersionConsistent/);
  assert.match(sync, /changedManifestFiles\(manifest, remoteFiles\)/);
  assert.match(sync, /manifest: uploadManifest/);
  assert.match(sync, /if \(!Object\.keys\(uploadManifest\)\.length\)/);
  assert.match(sync, /preComparedManifest: hashCompare/);
  assert.match(sync, /if \(!hashCompare\) \{\s+const requiredSources/);
  const fingerprint = extension.slice(extension.indexOf("async localDistributedCodeFingerprint("), extension.indexOf("async resumePersistedDistributedQueue("));
  assert.match(fingerprint, /cacheFile: this\.localCodeManifestCacheFile\(root\)/);
});

test("rerun code sync also compares hashes before uploading", () => {
  const codeReady = extension.slice(extension.indexOf("async ensureCodeReadyForRun("), extension.indexOf("async ensureHubCodeReadyForPlanCheck("));
  assert.match(codeReady, /syncCodeTargets\(targets, "run", \{ projectContext, hashCompare: true,/);
});

test("distributed job exposes one identity-bound tmux log jump and no inline log preview", () => {
  const start = renderedPanel.indexOf("function executionPlanGroupKey(");
  const end = renderedPanel.indexOf("function renderOperationSection(state)", start);
  assert.ok(start >= 0 && end > start);
  const source = renderedPanel.slice(start, end);
  let html = "";
  const sandbox = {
    selectedExecutionPlanFile: "",
    collapsedExecutionPlanKeys: new Set(),
    persistWebviewState: () => undefined,
    operationRowsForState: () => [],
    taskSectionViewModelForState: () => ({ allRows: [] }),
    normalizePlanSelectionKey: (value) => String(value || "").replace(/^\.\//, ""),
    executionHistoryRowVisible: () => true,
    taskSelectionSetsForState: () => ({}),
    planBaseName: (value) => String(value).split("/").at(-1),
    TASK_LIVE_STATUS_TOKENS: new Set(),
    TASK_QUEUED_STATUSES: new Set(),
    TASK_TERMINAL_STATUSES: new Set(),
    taskStatusToken: (value) => value,
    samePlanSelection: (a, b) => a === b,
    loadingPrefix: (active) => active ? '<span class="loading-spinner"></span>' : "",
    statusClass: (value) => value,
    esc: (value) => String(value).replaceAll("<", "&lt;"),
    escAttr: (value) => String(value).replaceAll('"', "&quot;"),
    detailsOpenAttr: (_key, open) => open ? " open" : "",
    logPayloadText: (value) => value && value.text || "",
    compactTaskLogText: (value) => value,
    setHtmlIfChanged: (_id, value) => { html = value; },
  };
  vm.runInNewContext(source + "\nglobalThis.renderExecutionPlanList = renderExecutionPlanList;", sandbox);
  const state = { logs: { "tmp/tmux_logs/job.log": { text: "epoch 3/20" } }, distributedPlans: [{
    planFile: "experiments/plans/comparison/concatenation.yaml", enqueuedAt: "2026-01-01",
    jobs: [{ index: 0, case: "bus", seed: 42, status: "running", workerId: "nwpu2", outputDir: "work_dirs/bus/attempts/new",
      commandId: "command-123", logPath: "tmp/tmux_logs/job.log" }],
  }] };
  sandbox.renderExecutionPlanList(state);
  assert.match(html, /data-job-tmux-log="1"/);
  assert.match(html, /data-command-id="command-123"/);
  assert.match(html, /data-output-dir="work_dirs\/bus\/attempts\/new"/);
  assert.equal((html.match(/>跳转到日志</g) || []).length, 1);
  assert.doesNotMatch(html, /data-run-key=|训练日志|终端日志|epoch 3\/20/);
  assert.match(html, /loading-spinner/);
  state.selectedLogRunKey = "work_dirs/bus/attempts/new/train.log";
  state.logs[state.selectedLogRunKey] = { text: "Epoch 1: Val Loss = 0.5" };
  sandbox.renderExecutionPlanList(state);
  assert.doesNotMatch(html, /Epoch 1: Val Loss = 0\.5/);
  state.distributedPlans[0].jobs[0].status = "completed";
  sandbox.renderExecutionPlanList(state);
  assert.doesNotMatch(html, /loading-spinner/);
  state.distributedPlans[0].jobs[0].workerId = "";
  sandbox.renderExecutionPlanList(state);
  assert.match(html, /data-job-tmux-log="1"[^>]* disabled/);
});

test("selected Worker log appends new bytes while polling", async () => {
  const client = Object.create(MultiEndpointRealtimeClient.prototype);
  const calls = [];
  client.endpointById = new Map([["nwpu2", { role: "worker" }]]);
  client.clients = new Map([["nwpu2", { getLiveOutput: async (_key, since) => {
    calls.push(since);
    return since ? { text: "epoch 4", offset: 14 } : { text: "epoch 3", offset: 7 };
  } }]]);
  client.mergedState = { logs: {}, lastSeq: 0 };
  client.protectedLogKeys = [];
  client.onState = () => undefined;
  await client.getLiveOutput("tmp/tmux_logs/job.log", 0, "nwpu2");
  await client.getLiveOutput("tmp/tmux_logs/job.log", 7, "nwpu2");
  assert.deepEqual(calls, [0, 7]);
  assert.equal(client.mergedState.logs["tmp/tmux_logs/job.log"].text, "epoch 3epoch 4");
  assert.equal(client.mergedState.logs["tmp/tmux_logs/job.log"].offset, 14);
  assert.match(extension, /refreshSelectedDistributedLog\(queue, newTerminal\)/);
  assert.match(extension, /job\.outputDir[\s\S]{0,90}train\.log[\s\S]{0,150}this\.selectedLogRunKey/);
  assert.match(extension, /Math\.max\(0, Number\(previous\?\.offset\) \|\| 0\)/);
});
