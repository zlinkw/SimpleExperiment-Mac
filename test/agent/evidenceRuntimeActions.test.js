const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("hub agent evidence actions write checkpoint dataset recovery anomaly and plotting outputs", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-agent-evidence-"));
  fs.mkdirSync(path.join(project, "work_dirs", "run_old"), { recursive: true });
  fs.mkdirSync(path.join(project, "work_dirs", "run_best"), { recursive: true });
  fs.mkdirSync(path.join(project, "experiments", "runs", "current"), { recursive: true });
  fs.mkdirSync(path.join(project, "experiments", "runs", "best"), { recursive: true });
  fs.mkdirSync(path.join(project, "datasets"), { recursive: true });
  fs.mkdirSync(path.join(project, "simple_cluster", "results"), { recursive: true });
  fs.writeFileSync(path.join(project, "work_dirs", "run_old", "old.ckpt"), "old", "utf8");
  fs.writeFileSync(path.join(project, "work_dirs", "run_best", "best.ckpt"), "best", "utf8");
  fs.writeFileSync(path.join(project, "checkpoint_manifest.json"), JSON.stringify({
    checkpoints: [
      { path: "work_dirs/run_best/best.ckpt", type: "best", score: 0.95, epoch: 10 },
      { path: "work_dirs/run_old/old.ckpt", type: "regular", score: 0.5, epoch: 1, updatedAt: "2025-01-01T00:00:00Z" },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(project, "datasets", "split.csv"), [
    "case_id,patient_id,split,class,file",
    "c1,p1,train,pos,images/a.png",
    "c2,p1,test,neg,images/b.png",
  ].join("\n"), "utf8");
  for (const runId of ["current", "best"]) {
    const runDir = path.join(project, "experiments", "runs", runId);
    fs.writeFileSync(path.join(runDir, "command.txt"), `python train.py --config configs/${runId}.yaml --seed 1 --output-dir experiments/runs/${runId}\n`, "utf8");
    fs.writeFileSync(path.join(runDir, "config_snapshot.yaml"), runId === "current" ? "lr: 0.1\nseed: 1\n" : "lr: 0.001\nseed: 1\n", "utf8");
    fs.writeFileSync(path.join(runDir, "env_snapshot.json"), JSON.stringify({ git_commit: "abc", command: "python train.py --seed 1" }), "utf8");
    fs.writeFileSync(path.join(runDir, "artifact_manifest.json"), JSON.stringify({ result_csv: `experiments/runs/${runId}/metrics_summary.csv` }), "utf8");
    fs.writeFileSync(path.join(runDir, "stdout.log"), runId === "current" ? "CUDA out of memory\nAUC: 0.70\n" : "AUC: 0.90\n", "utf8");
    fs.writeFileSync(path.join(runDir, "metrics_summary.csv"), [
      "experiment_id,suite,method,dataset,split,seed,metric,value",
      `${runId},classification,${runId},VinDr,test,1,AUC,${runId === "current" ? "0.70" : "0.90"}`,
    ].join("\n"), "utf8");
  }
  const script = path.join(project, "evidence-actions.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib, os
root = pathlib.Path(${JSON.stringify(project)})
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
outputs = {}
for action, payload in [
    ("parse-results", {"opId": "parse"}),
    ("plan-checkpoint-retention", {"opId": "ckpt"}),
    ("inspect-dataset", {"opId": "dataset"}),
    ("export-plotting-contract", {"opId": "plot"}),
    ("infer-config-from-run", {"opId": "infer", "runKey": "current"}),
    ("recover-plan-from-run", {"opId": "recover", "runKey": "current"}),
    ("diagnose-result-anomaly", {"opId": "diag", "runKey": "current"}),
    ("compare-with-best-config", {"opId": "cmp", "runKey": "current"}),
]:
    outputs[action] = agent.handle_action(str(root), action, payload, payload["opId"], payload["opId"])
exists = {rel: os.path.exists(root / rel) for rel in [
  "simple_cluster/checkpoints/delete_plan.json",
  "simple_cluster/checkpoints/retention_report.md",
  "simple_cluster/datasets/profile.json",
  "simple_cluster/datasets/leakage_report.csv",
  "simple_cluster/results/plotting_contract.json",
  "simple_cluster/plans/recovered/current.yaml",
]}
print(json.dumps({"outputs": outputs, "exists": exists}, ensure_ascii=False))
`, "utf8");
  const run = spawnSync(python, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.outputs["plan-checkpoint-retention"].status, "completed");
  assert.equal(result.outputs["inspect-dataset"].status, "failed");
  assert.equal(result.outputs["export-plotting-contract"].status, "completed");
  assert.match(result.outputs["recover-plan-from-run"].recoveredPlanYamlPath, /simple_cluster\/plans\/recovered\/current\.yaml/);
  assert.equal(result.outputs["diagnose-result-anomaly"].status, "failed");
  assert.equal(result.outputs["compare-with-best-config"].status, "failed");
  for (const [file, ok] of Object.entries(result.exists)) assert.equal(ok, true, file);
  for (const key of ["anomalyPath", "configDiffPath"]) {
    const relativePath = result.outputs["diagnose-result-anomaly"][key];
    assert.match(relativePath, /^simple_cluster\/results\/anomaly\/[a-f0-9]{16}(?:\.config_diff)?\.json$/);
    assert.equal(fs.existsSync(path.join(project, relativePath)), true, relativePath);
  }
});
