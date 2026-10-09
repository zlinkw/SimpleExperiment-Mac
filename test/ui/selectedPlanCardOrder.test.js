const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const start = panel.indexOf("function planVisibleRows(");
assert.ok(start >= 0);
const end = panel.indexOf("function compactPlanArrayText(", start);
assert.ok(end > start);
const source = panel.slice(start, end);
const sandbox = {
  asArray: (value) => Array.isArray(value) ? value : [],
  normalizePlanSelectionKey: (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""),
  planMatchesSelection: (state, plan) => state.planFileInput === plan.file || String(state.planFileInput || "").split("/").pop() === String(plan.file || "").split("/").pop(),
};
vm.createContext(sandbox);
vm.runInContext(source + "\nthis.visible = planVisibleRows;", sandbox);

test("only the selected Plan card is visible", () => {
  const plans = Array.from({ length: 40 }, (_, i) => ({ file: `plans/plan-${i}.yaml` }));
  const rows = sandbox.visible({ planFileInput: "plans/plan-37.yaml" }, plans);
  assert.deepEqual(Array.from(rows, (row) => row.plan.file), ["plans/plan-37.yaml"]);
  assert.equal(sandbox.visible({ planFileInput: "" }, plans).length, 0);
  assert.equal(sandbox.visible({ planFileInput: "plans/unknown.yaml" }, plans).length, 0);
});

test("exact Plan path wins when filenames repeat", () => {
  const plans = [{ file: "plans/old/demo.yaml" }, { file: "plans/current/demo.yaml" }];
  const rows = sandbox.visible({ planFileInput: "plans/current/demo.yaml" }, plans);
  assert.deepEqual(Array.from(rows, (row) => row.plan.file), ["plans/current/demo.yaml"]);
});
