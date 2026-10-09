const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const Results = require("../../dist/features/Results");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function extractAgent() { return readBuiltAgentRuntime(); }

function nestedResult() {
  return {
    results: [
      {
        run: { id: "run-1", suite: "smoke" },
        dimensions: { method: "ours", dataset: "demo", split: "test", seed: 7 },
        model: { type: "Classifier" },
        metrics: [
          { name: "AUC", value: 0.88, split: "val" },
          { metric: "AUC", score: 0.91, split: "test" },
          { key: "loss", val: 0.2 },
          { name: "custom_score", value: 12.5 },
        ],
      },
    ],
  };
}

test("local preview parses nested JSON dimensions and metric lists", () => {
  const preset = Results.selectResultPreset("work_dirs/smoke/results.json");
  const text = JSON.stringify(nestedResult());
  const source = { path: "work_dirs/smoke/results.json", type: "json", endpoint: "local" };
  const records = Results.parseResultFile(text, source, preset);
  assert.equal(records.length, 1);
  const row = records[0];
  assert.equal(row.experimentId, "run-1");
  assert.equal(row.runKey, "run-1");
  assert.equal(row.suite, "smoke");
  assert.equal(row.dimensions.method, "ours");
  assert.equal(row.dimensions.dataset, "demo");
  assert.equal(row.dimensions.seed, "7");
  assert.equal(row.metrics.AUC.value, 0.91);
  assert.equal(row.metrics.AUC.split, "test");
  assert.equal(row.metrics.val_AUC.value, 0.88);
  assert.equal(row.metrics.loss.value, 0.2);
  assert.equal(row.metrics.custom_score.value, 12.5);

  const preview = Results.previewResultParse(text, source.path, preset);
  assert.equal(preview.records, 1);
  assert.ok(preview.columns.some((item) => item.toLowerCase() === "metrics.val_auc"));
  assert.ok(preview.columns.some((item) => item.toLowerCase() === "metrics.test_auc"));

  const noMetrics = Results.parseResultFile(JSON.stringify({ results: [{ seed: 1, pid: 20, gpu_id: 0, status: "ok" }] }), source, preset);
  assert.equal(noMetrics.length, 0);
});

test("result parser reuses fixed JSON metadata and segmentation metric lookups", () => {
  const source = readSource("src/features/Results.ts");
  assert.match(source, /const jsonNonMetricNames = new Set\(\[/);
  assert.match(source, /const segmentationMetricNames = new Set\(\["DSC", "Dice", "IoU", "HD95", "ASD"\]\)/);
  assert.match(source, /return !jsonNonMetricNames\.has\(normalized\)/);
  assert.match(source, /!jsonNonMetricNames\.has\(key\.toLowerCase\(\)\)/);
  assert.match(source, /return segmentationMetricNames\.has\(metric\)/);
  assert.doesNotMatch(source, /return !new Set\(\["experiment_id"/);
  assert.doesNotMatch(source, /return new Set\(\["DSC", "Dice", "IoU", "HD95", "ASD"\]\)\.has/);
});

test("Hub Agent keeps nested JSON dimensions and split metrics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-nested-json-"));
  const project = path.join(root, "project");
  const resultDir = path.join(project, "work_dirs", "smoke");
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, "results.json"), JSON.stringify(nestedResult()), "utf8");

  const agentSource = readSource("src/clusterAgentRuntime.ts");
  const agentPath = path.join(root, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(agentSource), "utf8");
  const script = path.join(root, "check.py");
  fs.writeFileSync(script, [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', ${JSON.stringify(agentPath)})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(project)}`,
    "summary = agent.parse_results_action(root)",
    "print(json.dumps({'rows': summary.get('results') or [], 'sources': summary.get('sources') or []}))",
  ].join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());
  assert.ok(payload.sources.includes("work_dirs/smoke/results.json"));
  const rows = payload.rows;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.experimentId, "run-1");
  assert.equal(row.runKey, "run-1");
  assert.equal(row.suite, "smoke");
  assert.equal(row.dimensions.method, "ours");
  assert.equal(row.dimensions.dataset, "demo");
  assert.equal(row.dimensions.seed, 7);
  assert.equal(row.metrics.AUC.value, 0.91);
  assert.equal(row.metrics.AUC.split, "test");
  assert.equal(row.metrics.val_AUC.value, 0.88);
  assert.equal(row.metrics.loss.value, 0.2);
  assert.equal(row.metrics.custom_score.value, 12.5);
});
