const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agent = readSource("src/clusterAgentRuntime.ts");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = extension.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = extension.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractFrozenObject(name) {
  const start = extension.indexOf(`const ${name} = Object.freeze({`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = extension.indexOf("});", start);
  assert.ok(end > start, `unterminated ${name}`);
  return extension.slice(start, end + 3);
}

function extractFrozenArray(name) {
  const start = extension.indexOf(`const ${name} = Object.freeze([`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = extension.indexOf("]);", start);
  assert.ok(end > start, `unterminated ${name}`);
  return extension.slice(start, end + 3);
}

function remoteActionTargetFieldSources() {
  return [
    "REMOTE_ACTION_PATH_FIELDS",
    "REMOTE_ACTION_IDENTIFIER_FIELDS",
    "REMOTE_ACTION_IDENTIFIER_LIST_FIELDS",
    "REMOTE_ACTION_TASK_TARGET_PATH_FIELDS",
  ].map(extractFrozenArray);
}

test("sync artifact action is presented as a manifest preflight, not a transfer", () => {
  assert.match(panel, /syncArtifacts: "检查同步清单"/);
  assert.match(panel, /traceActionButton\("检查同步清单", "syncArtifacts"/);
  assert.match(panel, /data-confirmation-path=/);
  assert.match(panel, /data-artifact-path=/);
  assert.match(panel, /data-result-path=/);
  assert.match(panel, /data-log-path=/);
  assert.match(panel, /payload\.confirmationPath = button\.dataset\.confirmationPath/);
  assert.match(panel, /artifactPath: cleanSelectionValue\(row\.artifactPath\)/);
  assert.match(panel, /resultPath: cleanSelectionValue\(row\.resultPath\)/);
  assert.match(panel, /logPath: cleanSelectionValue\(row\.logPath\)/);
  assert.doesNotMatch(panel, /syncArtifacts: "同步产物"/);
  assert.match(agent, /同步清单检查完成（未传输文件）/);
  assert.match(extension, /showWarningMessage\(remoteActionConfirmationDetail\(command, action, body\), \{ modal: true \}/);
  assert.match(extension, /confirmationPath: confirmationPath \|\| undefined/);
  assert.match(extension, /artifactPath: artifactPath \|\| undefined/);
  assert.match(extension, /resultPath: resultPath \|\| undefined/);
  assert.match(extension, /logPath: logPath \|\| undefined/);
  assert.match(extension, /showWarningMessage\(workerRemoteActionConfirmationDetail\(options\.title, action, body, ids\), \{ modal: true \}/);
  assert.match(extension, /showWarningMessage\(workerRemoteActionConfirmationDetail\(command, action, body, \[workerId\]\), \{ modal: true \}/);
  assert.match(extension, /const REMOTE_ACTION_DISPLAY_NAMES = Object\.freeze\(\{/);
  assert.match(extractFunction("remoteActionDisplayName"), /REMOTE_ACTION_DISPLAY_NAMES\[String\(command \|\| ""\)\]/);
  assert.doesNotMatch(extractFunction("remoteActionDisplayName"), /const names =/);
  const previewSource = extractFunction("remoteActionTargetPreview");
  assert.match(extension, /const REMOTE_ACTION_PATH_FIELDS = Object\.freeze\(\[/);
  assert.match(extension, /const REMOTE_ACTION_IDENTIFIER_FIELDS = Object\.freeze\(\[/);
  assert.match(extension, /const REMOTE_ACTION_IDENTIFIER_LIST_FIELDS = Object\.freeze\(\[/);
  assert.match(extension, /const REMOTE_ACTION_TASK_TARGET_PATH_FIELDS = Object\.freeze\(\[/);
  assert.match(previewSource, /for \(const key of REMOTE_ACTION_PATH_FIELDS\)/);
  assert.match(previewSource, /for \(const key of REMOTE_ACTION_IDENTIFIER_FIELDS\)/);
  assert.match(previewSource, /for \(const key of REMOTE_ACTION_IDENTIFIER_LIST_FIELDS\)/);
  assert.match(previewSource, /for \(const key of REMOTE_ACTION_TASK_TARGET_PATH_FIELDS\)/);
  assert.doesNotMatch(previewSource, /for \(const key of \[/);

  const fieldSandbox = {};
  vm.createContext(fieldSandbox);
  vm.runInContext([...remoteActionTargetFieldSources(), "this.fields = [REMOTE_ACTION_PATH_FIELDS, REMOTE_ACTION_IDENTIFIER_FIELDS, REMOTE_ACTION_IDENTIFIER_LIST_FIELDS, REMOTE_ACTION_TASK_TARGET_PATH_FIELDS];"].join("\n"), fieldSandbox);
  assert.equal(fieldSandbox.fields.every(Object.isFrozen), true);
});
test("sync manifest modal lists expected paths and states every excluded side effect", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    ...remoteActionTargetFieldSources(),
    extractFrozenObject("REMOTE_ACTION_DISPLAY_NAMES"),
    extractFunction("remoteActionTargetPreview"),
    extractFunction("remoteActionDisplayName"),
    extractFunction("remoteActionConfirmationDetail"),
  ].join("\n"), sandbox);

  const detail = sandbox.remoteActionConfirmationDetail("syncArtifacts", "sync-artifacts", {
    selectedPlanId: "experiments/plans/demo.yaml",
    selectedArchiveKeys: ["run-a"],
    confirmationPath: "/srv/worker/demo/results/run-a/metrics.csv",
    selectedTaskTargets: [
      { resultPath: "/srv/worker/demo/results/run-a/metrics.csv", archiveKey: "run-a" },
    ],
  });

  assert.match(detail, /【强制确认】检查同步清单/);
  assert.match(detail, /Plan：experiments\/plans\/demo.yaml/);
  assert.match(detail, /文件位置：1 个；任务标识：1 个/);
  assert.match(detail, /预期操作文件位置：/);
  assert.match(detail, /\/srv\/worker\/demo\/results\/run-a\/metrics.csv/);
  assert.match(detail, /任务标识：/);
  assert.match(detail, /run-a/);
  assert.match(detail, /不会上传、下载或移动文件/);
  assert.match(detail, /不会把目标标记为已归档/);
  assert.match(detail, /实际文件同步流程/);
  assert.match(detail, /三方一致校验/);
});

test("all confirmed task actions show expected file locations", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    ...remoteActionTargetFieldSources(),
    extractFrozenObject("REMOTE_ACTION_DISPLAY_NAMES"),
    extractFunction("remoteActionTargetPreview"),
    extractFunction("remoteActionDisplayName"),
    extractFunction("remoteActionConfirmationDetail"),
  ].join("\n"), sandbox);

  for (const [command, action] of [
    ["stopExperiment", "stop-experiment"],
    ["retryExperiment", "retry-experiment"],
    ["archiveArtifacts", "archive-artifacts"],
    ["completeThreeWay", "complete-three-way"],
    ["deleteArtifacts", "delete-artifacts"],
  ]) {
    const detail = sandbox.remoteActionConfirmationDetail(command, action, {
      selectedPlanId: "experiments/plans/demo.yaml",
      selectedTaskTargets: [{
        runKey: "run-a",
        artifactPath: "/srv/worker/demo/results/run-a",
        resultPath: "/srv/worker/demo/results/run-a/metrics.csv",
        logPath: "/srv/worker/demo/results/run-a/stdout.log",
      }],
    });
    assert.match(detail, /【强制确认】/);
    assert.match(detail, /预期操作文件位置：/);
    assert.match(detail, /\/srv\/worker\/demo\/results\/run-a\/metrics.csv/);
    assert.match(detail, /\/srv\/worker\/demo\/results\/run-a\/stdout.log/);
    assert.match(detail, /任务标识：/);
  }
});

test("direct Worker strong confirmations retain file locations", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    ...remoteActionTargetFieldSources(),
    extractFrozenObject("REMOTE_ACTION_DISPLAY_NAMES"),
    extractFunction("remoteActionTargetPreview"),
    extractFunction("remoteActionDisplayName"),
    extractFunction("remoteActionConfirmationDetail"),
    extractFunction("workerRemoteActionConfirmationDetail"),
  ].join("\n"), sandbox);

  const detail = sandbox.workerRemoteActionConfirmationDetail("deleteArtifacts", "delete-artifacts", {
    archiveKey: "/srv/worker/demo/results/run-a",
    resultPath: "/srv/worker/demo/results/run-a/metrics.csv",
  }, ["worker-a", "worker-b"]);
  assert.match(detail, /【强制确认】删除产物/);
  assert.match(detail, /预期操作文件位置：/);
  assert.match(detail, /\/srv\/worker\/demo\/results\/run-a\/metrics.csv/);
  assert.match(detail, /直达 2 个 Worker Agent：worker-a、worker-b/);
});
