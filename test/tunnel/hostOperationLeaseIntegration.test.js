const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension/legacy.ts");
const compiled = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");

test("SimpleExperiment routes UI side effects through the shared host lease", () => {
  assert.match(source, /require\("\.\.\/core\/HostOperationLease"\)/);
  assert.match(compiled, /require\("\.\.\/core\/HostOperationLease"\)/);
  assert.match(source, /this\.hostOperationLease\.run\(/);
  assert.match(source, /hostOperationLeaseActionForUiCommand\(command\)/);
  assert.match(source, /runActionCommandCore\(command, message\)/);
  for (const command of [
    "startAllConnections",
    "prepareAgents",
    "runPlan",
    "archiveArtifacts",
    "deleteArtifacts",
    "uploadProjectToHub",
    "deployLatestAgent",
    "downloadRemoteResult",
    "openResultArtifact",
  ]) {
    assert.match(source, new RegExp(`\\"${command}\\"`), command);
  }
});

test("read-only state commands are not included in the host side-effect set", () => {
  const start = source.indexOf("const hostOperationUiCommands = new Set([");
  const end = source.indexOf("]);", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (const command of ["snapshot", "manualGpuSnapshot", "loadGpuHistory", "manualSchedulerSnapshot", "manualTracesSnapshot", "testAll"]) {
    assert.doesNotMatch(block, new RegExp(`\\"${command}\\"`), command);
  }
});

test("host operation labels reuse one frozen lookup table", () => {
  for (const text of [source, compiled]) {
    assert.match(text, /const HOST_OPERATION_LEASE_ACTION_LABELS = Object\.freeze\(\{/);
    assert.match(text, /quickSetup: "检查服务器配置"/);
    assert.match(text, /openResultArtifact: "打开或下载结果文件"/);
    const start = text.indexOf("function hostOperationLeaseActionLabel(command)");
    const end = text.indexOf("function commandNeedsUiStatus", start);
    assert.ok(start >= 0 && end > start);
    const block = text.slice(start, end);
    assert.match(block, /HOST_OPERATION_LEASE_ACTION_LABELS\[command\] \|\| command/);
    assert.doesNotMatch(block, /const labels =/);
  }
});
