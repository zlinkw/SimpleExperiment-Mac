const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function extractAgent() { return readBuiltAgentRuntime(); }

function write(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function plan(suite, resultPath) {
  return [
    `suite: ${suite}`,
    "mode: test",
    "paper:",
    `  result_csv: ${resultPath}`,
    "cases:",
    "  - case: smoke",
  ].join("\n");
}

function snapshots(root, directory) {
  write(root, `${directory}/env_snapshot.json`, '{"python":"3.10"}\n');
  write(root, `${directory}/config_snapshot.yaml`, "seed: 0\n");
}

test("output contract accepts declared CSV, JSON, and text results without cross-plan or metadata leakage", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-output-contract-"));
  const root = path.join(tmp, "project");
  const source = readSource("src/clusterAgentRuntime.ts");
  const agentPath = path.join(tmp, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(source), "utf8");

  const cases = {
    canonical: "work_dirs/canonical/metrics_summary.csv",
    json: "work_dirs/json/metrics.json",
    text: "work_dirs/text/summary.txt",
    invalid: "work_dirs/invalid/metrics.json",
    missing_snapshots: "work_dirs/missing_snapshots/metrics.json",
    metadata: "work_dirs/metadata/status.json",
    multi: "work_dirs/multi/bad.json",
    current: "work_dirs/current/metrics.json",
  };
  for (const [suite, resultPath] of Object.entries(cases)) {
    write(root, `experiments/plans/${suite}.yaml`, plan(suite, resultPath));
  }
  write(root, "experiments/plans/multi.yaml", [
    "suite: multi",
    "mode: test",
    "expectedResults:",
    "  - work_dirs/multi/bad.json",
    "  - work_dirs/multi/summary.txt",
    "cases:",
    "  - case: smoke",
  ].join("\n"));

  write(root, cases.canonical, "experiment_id,metric,value\nrun-1,AUC,0.91\n");
  snapshots(root, "work_dirs/canonical");
  write(root, cases.json, JSON.stringify({ metrics: { AUC: 0.92 }, seed: 0 }));
  snapshots(root, "work_dirs/json");
  write(root, cases.text, "AUC: 0.93\nloss=0.2\n");
  snapshots(root, "work_dirs/text");
  write(root, cases.invalid, JSON.stringify({ results: [{ status: "done", seed: 1 }] }));
  snapshots(root, "work_dirs/invalid");
  write(root, cases.missing_snapshots, JSON.stringify({ metrics: { AUC: 0.94 } }));
  write(root, cases.metadata, JSON.stringify({ status: "done", progress: 100, pid: 1234 }));
  snapshots(root, "work_dirs/metadata");
  write(root, "work_dirs/multi/bad.json", JSON.stringify({ status: "done" }));
  write(root, "work_dirs/multi/summary.txt", "AUC: 0.95\n");
  snapshots(root, "work_dirs/multi");
  write(root, "work_dirs/other/metrics.json", JSON.stringify({ metrics: { AUC: 0.99 } }));
  snapshots(root, "work_dirs/other");

  const script = path.join(tmp, "check.py");
  const plans = Object.keys(cases);
  fs.writeFileSync(script, [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', ${JSON.stringify(agentPath)})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(root)}`,
    `plans = ${JSON.stringify(plans)}`,
    "reports = {name: agent.check_output_contract_action(root, 'experiments/plans/' + name + '.yaml') for name in plans}",
    "reports['internalCandidate'] = agent.output_contract_result_candidate('simple_cluster/results/by_plan/current/statistics.json')",
    "print(json.dumps(reports))",
  ].join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reports = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());

  for (const name of ["canonical", "json", "text", "multi"]) {
    assert.equal(reports[name].status, "ok", `${name}: ${reports[name].message}`);
    assert.ok(reports[name].parseableResultCount > 0);
  }
  assert.deepEqual(reports.canonical.metricFiles, [cases.canonical]);
  assert.deepEqual(reports.json.resultFiles, [cases.json]);
  assert.deepEqual(reports.text.resultFiles, [cases.text]);

  assert.equal(reports.invalid.status, "failed");
  assert.equal(reports.invalid.issueType, "unparseable_result");
  assert.deepEqual(reports.invalid.missing, []);
  assert.deepEqual(reports.invalid.unparseableFiles, [cases.invalid]);
  assert.match(reports.invalid.unparseable[0].error, /数值指标/);

  assert.equal(reports.missing_snapshots.status, "failed");
  assert.equal(reports.missing_snapshots.issueType, "missing_files");
  assert.equal(reports.missing_snapshots.parseableResultCount, 1);
  assert.deepEqual(reports.missing_snapshots.missing.sort(), ["config_snapshot.yaml", "env_snapshot.json"]);

  assert.equal(reports.metadata.status, "failed");
  assert.equal(reports.metadata.issueType, "missing_files");
  assert.deepEqual(reports.metadata.resultFiles, []);
  assert.deepEqual(reports.metadata.missing.sort(), ["config_snapshot.yaml", "env_snapshot.json", "parseable_result_file"]);

  assert.equal(reports.multi.status, "ok");
  assert.ok(reports.multi.resultFiles.includes("work_dirs/multi/bad.json"));
  assert.ok(reports.multi.resultFiles.includes("work_dirs/multi/summary.txt"));
  assert.deepEqual(reports.multi.unparseableFiles, ["work_dirs/multi/bad.json"]);

  assert.equal(reports.current.status, "failed");
  assert.equal(reports.current.issueType, "missing_files");
  assert.deepEqual(reports.current.resultFiles, []);
  assert.deepEqual(reports.current.missing.sort(), ["config_snapshot.yaml", "env_snapshot.json", "parseable_result_file"]);
  assert.ok(!reports.current.files.some((item) => item.startsWith("work_dirs/other/")));
  assert.equal(reports.internalCandidate, "");
});
