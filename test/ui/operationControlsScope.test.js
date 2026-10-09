const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
function extract(startName, endName) {
  const start = panel.indexOf(`function ${startName}(`);
  const end = panel.indexOf(`function ${endName}(`, start + 1);
  assert.ok(start >= 0 && end > start);
  return panel.slice(start, end);
}

test("global stop targets only the active operation for the selected Plan", () => {
  const html = {};
  const sandbox = {
    renderFileTransferProgress: () => "",
    operationViewModelForState: () => ({ rows: [] }),
    setHtmlIfChanged: (id, value) => { html[id] = value; },
    escAttr: String,
    esc: String,
    operationIsActive: (status) => status === "running",
    selectedExecutionPlanFile: "experiments/plans/comparison/concatenation.yaml",
    selectedOperationHistoryIds: new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("renderOperationSection", "renderFileTransferProgress").replaceAll("\\\\", "\\") + "\nthis.render = renderOperationSection;", sandbox);
  sandbox.render({
    planFileInput: "experiments/plans/comparison/concatenation.yaml",
    operations: {
      ebmc: { operationId: "ebmc", type: "run-plan", status: "running", planFile: "experiments/plans/comparison/ebmc.yaml" },
      concat: { operationId: "concat", type: "run-plan", status: "running", planFile: "experiments/plans/comparison/concatenation.yaml" },
    },
  });
  assert.match(html.executionControls, /data-command="stopExperiment" data-operation-id="concat"/);
  assert.doesNotMatch(html.executionControls, /data-operation-id="ebmc"/);
  assert.match(html.executionControls, /data-command="stopAllPlans"/);
  assert.match(html.executionControls, /data-command="clearOperations"[^>]*>清除所有历史/);
  assert.match(html.executionControls, /id="clearSelectedOperationHistory"[^>]*disabled[^>]*>清理选中记录/);
  assert.match(html.executionControls, /data-command="clearOperations" data-plan-file="experiments\/plans\/comparison\/concatenation.yaml"[^>]*>清除所选 Plan 历史/);
  const clearAll = html.executionControls.match(/<button[^>]*data-command="clearOperations"[^>]*>清除所有历史/)[0];
  assert.doesNotMatch(clearAll, /\sdisabled(?:\s|>)/);
});

test("running progress and GPU card use the same curve viewer entry", () => {
  const status = { nwpu3: { running: true } };
  const sandbox = {
    lastState: { topology: { hubAllowed: false }, setup: {} },
    enabledWorkerTunnelsForState: () => [{ id: "nwpu3", name: "NWPU3" }],
    gpuTensorboardStatus: status,
    escAttr: String,
    esc: String,
  };
  vm.createContext(sandbox);
  vm.runInContext(extract("renderTensorBoardLinksForRunning", "renderSchedulerDependencyStatus") + "\nthis.render = renderTensorBoardLinksForRunning;", sandbox);
  assert.match(sandbox.render(), /data-command="openScalarViewer"[^>]*>NWPU3 · 打开曲线/);
  status.nwpu3.running = false;
  assert.match(sandbox.render(), /data-command="openScalarViewer"[^>]*>NWPU3 · 打开曲线/);
});
