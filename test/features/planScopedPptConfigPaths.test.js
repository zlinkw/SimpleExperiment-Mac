const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function extractAgent() { return readBuiltAgentRuntime(); }

function pyString(value) {
  return JSON.stringify(String(value));
}

test("ppt plot config buttons bind a statistics source path", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  // 统计源必须来自当前 Plan 的最终结果摘要，不能固定绑定旧的全局路径。
  assert.match(source, /function renderPptPlotConfig\(state\) \{[\s\S]*data-command="plotResultsToPpt"/);
  assert.match(source, /function pptPlotButton\(label, sourcePath, sourceLabel, extra\)/);
  assert.match(source, /const statisticsSourcePath = finalStatisticsSourcePath\(resultSummary\)/);
  assert.match(source, /data-source-path="' \+ escAttr\(statisticsSourcePath\)/);
  assert.doesNotMatch(source, /data-source-path="simple_cluster\/results\/statistics\.json"/);
});

test("export plotting contract stamps summary plottingContractPath", () => {
  const agent = readSource("src/clusterAgentRuntime.ts");
  const py = fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"), "utf8");
  for (const source of [agent, py]) {
    assert.match(source, /summary\["plottingContractPath"\] = rel/);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-plot-stamp-"));
  const agentPath = path.join(tmp, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(agent), "utf8");
  const root = path.join(tmp, "project");
  fs.mkdirSync(path.join(root, "experiments", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, "work_dirs", "smoke", "a"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "experiments", "plans", "smoke.yaml"),
    [
      "suite: smoke",
      "mode: train_test",
      "base_config: configs/base.yaml",
      "seeds: [0]",
      "paper:",
      "  result_csv: work_dirs/smoke/a/metrics_summary.csv",
      "runner:",
      "  train_command: python train.py --output-dir work_dirs/smoke/a",
      "  test_command: python test.py --result-csv work_dirs/smoke/a/metrics_summary.csv",
      "cases:",
      "  - case: a",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "work_dirs", "smoke", "a", "metrics_summary.csv"),
    "experiment_id,method,dataset,split,seed,metric,value\nsmoke_a,baseline,ds,test,0,AUC,0.91\n",
    "utf8"
  );
  const script = path.join(tmp, "check.py");
  const lines = [];
  lines.push("import importlib.util, json");
  lines.push("spec = importlib.util.spec_from_file_location('agent', " + pyString(agentPath) + ")");
  lines.push("agent = importlib.util.module_from_spec(spec)");
  lines.push("spec.loader.exec_module(agent)");
  lines.push("root = " + pyString(root));
  lines.push("plan = 'experiments/plans/smoke.yaml'");
  lines.push("agent.parse_results_action(root, None, plan)");
  lines.push("report = agent.export_plotting_contract_action(root, plan)");
  lines.push("summary = agent.read_results_summary(root, plan)");
  lines.push("print(json.dumps({");
  lines.push("  'reportPath': report.get('path'),");
  lines.push("  'summaryPath': summary.get('plottingContractPath'),");
  lines.push("  'planFile': summary.get('planFile'),");
  lines.push("}))");
  fs.writeFileSync(script, lines.join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split("\n").pop());
  assert.match(String(payload.reportPath || ""), /by_plan/);
  assert.match(String(payload.summaryPath || ""), /by_plan.*plotting_contract\.json/);
  assert.equal(payload.planFile, "experiments/plans/smoke.yaml");
});
