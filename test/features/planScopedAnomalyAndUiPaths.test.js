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

test("anomaly diagnosis writes under plan-scoped anomaly dir", () => {
  const agent = readSource("src/clusterAgentRuntime.ts");
  const py = fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"), "utf8");
  for (const source of [agent, py]) {
    assert.match(source, /anomaly_rel = plan_results_artifact_relpath\(plan_norm, f"anomaly\/\{safe\}"\)/);
    assert.match(source, /"planFile": plan_norm or ""/);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-anomaly-plan-"));
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
    "experiment_id,method,dataset,split,seed,metric,value\nsmoke_a,baseline,ds,test,0,AUC,0.91\nsmoke_b,ours,ds,test,0,AUC,0.70\n",
    "utf8"
  );
  const script = path.join(tmp, "check.py");
  const lines = [];
  lines.push("import importlib.util, json, os");
  lines.push("spec = importlib.util.spec_from_file_location('agent', " + pyString(agentPath) + ")");
  lines.push("agent = importlib.util.module_from_spec(spec)");
  lines.push("spec.loader.exec_module(agent)");
  lines.push("root = " + pyString(root));
  lines.push("plan = 'experiments/plans/smoke.yaml'");
  lines.push("summary = agent.parse_results_action(root, None, plan)");
  lines.push("record = (summary.get('results') or [{}])[0]");
  lines.push("report = agent.diagnose_result_anomaly_action(root, {'planFile': plan, 'resultId': record.get('resultId'), 'metric': 'AUC'})");
  lines.push("json_path = ((report.get('outputFiles') or {}).get('jsonPath') or '')");
  lines.push("print(json.dumps({");
  lines.push("  'planFile': report.get('planFile'),");
  lines.push("  'jsonPath': json_path,");
  lines.push("  'exists': os.path.isfile(os.path.join(root, *json_path.split('/'))) if json_path else False,");
  lines.push("}))");
  fs.writeFileSync(script, lines.join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split("\n").pop());
  assert.equal(payload.planFile, "experiments/plans/smoke.yaml");
  assert.match(String(payload.jsonPath || ""), /by_plan.*anomaly/);
  assert.equal(payload.exists, true);
});

test("result evidence workbench keeps ppt plot buttons with artifact paths", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  // Plot actions must use the selected Plan's final artifacts, never global fallback paths.
  assert.match(source, /function pptPlotButton\(label, sourcePath, sourceLabel, extra\)/);
  assert.match(source, /const statisticsSourcePath = statisticsReady \? meaningfulValue\(statisticsPath\) : "";/);
  assert.match(source, /pptPlotButton\("均值绘图", statisticsSourcePath, "SCI 聚合统计"\)/);
  assert.match(source, /pptPlotButton\("契约页", analysisArtifacts\.plottingContractPath, "PPT 绘图契约"/);
  assert.doesNotMatch(source, /pptPlotButton\("(?:均值绘图|契约页)", "simple_cluster\/results\//);
  assert.match(source, /function renderResultEvidenceWorkbench\(state, summary\)/);
});
