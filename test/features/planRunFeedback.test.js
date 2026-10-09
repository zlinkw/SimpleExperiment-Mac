const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
const scope = fs.readFileSync(path.join(__dirname, "../../src/features/SyncScopeTree.ts"), "utf8");

test("runPlan reports click, sync, validate, dry-run, then scheduler start in order", () => {
  const submit = extension.slice(extension.indexOf("        if (PLAN_SUBMISSION_COMMANDS.has(command)) {\n            this.planRunStageStartedAt"), extension.indexOf("const danger = command === \"deleteArtifacts\";"));
  const marks = [
    "已收到校验并提交运行",
    "正在选择调度 Worker",
    "正在确认 SimpleSFTP",
    "ensureCodeReadyForRun",
    "runPlanPreflight",
    "预演通过，正在开启调度",
  ].map((text) => submit.indexOf(text));
  assert.ok(marks.every((index, position) => index > (position === 0 ? 0 : marks[position - 1])), marks.join(","));
  const preflight = extension.slice(extension.indexOf("async runPlanPreflight("), extension.indexOf("async confirmDistributedPlanExistingOutputs("));
  assert.ok(preflight.indexOf("正在校验计划") < preflight.indexOf("正在预演"));
  assert.match(panel, /function renderCommandPhaseLine/);
  assert.match(panel, /id="commandPhaseLine"/);
  const clickStart = panel.indexOf('const button = event.target.closest("button[data-command]")');
  const click = panel.slice(clickStart, clickStart + 8000);
  const loadingAt = click.indexOf("setButtonLoading(button, pendingKey)");
  const postAt = click.indexOf("vscode.postMessage(Object.assign({ command }, payload))");
  assert.ok(loadingAt > 0 && postAt > loadingAt);
});

test("sync scope tab opens before the unsaved full-tree walk", () => {
  const open = extension.slice(extension.indexOf("async configureCodeSyncIncludes("), extension.indexOf("async configureServerSyncScope("));
  const panelAt = open.indexOf("openSyncScopeTree(");
  const walkAt = open.indexOf("walkCodeFiles(root)");
  assert.ok(panelAt > 0 && walkAt > panelAt);
  assert.match(open, /void walkCodeFiles\(root\)/);
  assert.match(open, /scopeSelected/);
  assert.doesNotMatch(open.slice(0, panelAt), /await walkCodeFiles/);
  assert.match(scope, /type==='scopeLoading'/);
  assert.match(scope, /function applyScopeSelected/);
});

test("github completion names the pre-transfer stages and still uploads only changed files", () => {
  const publish = extension.slice(extension.indexOf("async publishToGitHub("), extension.indexOf("async overwriteFromGitHub("));
  assert.match(publish, /GitHub 已完成，正在准备 Worker 上传…/);
  assert.doesNotMatch(publish, /开始上传到 Worker/);
  const upload = extension.slice(extension.indexOf("async uploadProjectToWorkers("), extension.indexOf("async distributeCodeToWorkers("));
  assert.ok(upload.indexOf("正在准备 SFTP 目标") < upload.indexOf("开始核对本地代码清单") && upload.indexOf("开始核对本地代码清单") < upload.indexOf("syncManualWorkerCode"));
  const manual = extension.slice(extension.indexOf("async syncManualWorkerCode("), extension.indexOf("async deployLatestAgentRuntime("));
  assert.match(manual, /syncCodeTargets\(this\.workerCodeSyncTargets\(\), "workers"/);
  assert.match(manual, /allowLockedWorkerSkip: true/);
  assert.match(publish, /report\(upload\.message, 0\)/);
  const sync = extension.slice(extension.indexOf("async syncCodeTargets("), extension.indexOf("async inspectCodeSyncTarget("));
  const localAt = sync.indexOf("正在建立本地代码清单并核对文件哈希");
  const remoteAt = sync.indexOf("正在比对");
  const transferAt = sync.indexOf("正在传输");
  const uploadAt = sync.indexOf('executeCommand("simpleSftp.uploadWorkspace"');
  assert.ok(localAt > 0 && remoteAt > localAt && transferAt > remoteAt && uploadAt > transferAt);
  assert.match(sync, /changedManifestFiles\(manifest, remoteFiles\)/);
  assert.ok(sync.indexOf("if (!Object.keys(uploadManifest).length)") < uploadAt);
});
