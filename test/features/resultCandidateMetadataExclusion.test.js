const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const PlanBuilder = require("../../dist/features/PlanBuilder.js");
const Templates = require("../../dist/templates/ProjectAdapterTemplates.js");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function metadataPlan(extraResults = []) {
  return [
    "suite: metadata_only",
    "mode: test",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "runner:",
    "  test_command: python test.py",
    "cases:",
    "  - case: smoke",
    "    expectedResults:",
    "      - work_dirs/metadata_only/status.json",
    "      - work_dirs/metadata_only/artifact_manifest.json",
    "      - experiments/results/jobs.csv",
    ...extraResults.map((item) => `      - ${item}`),
  ].join("\n");
}

function extractAgent() { return readBuiltAgentRuntime(); }

test("Plan evidence rejects metadata-only outputs and keeps real result candidates", () => {
  const metadata = PlanBuilder.parsePlanOutputEvidence(metadataPlan());
  assert.deepEqual(metadata.evidenceCandidates, []);
  assert.deepEqual(metadata.outputCandidates, []);
  assert.deepEqual(metadata.outputSignals, []);
  assert.equal(PlanBuilder.validateDeepLearningPlanContract(metadataPlan()).ok, false);

  const mixed = PlanBuilder.parsePlanOutputEvidence(metadataPlan(["work_dirs/metadata_only/metrics_summary.csv"]));
  assert.deepEqual(mixed.evidenceCandidates, ["work_dirs/metadata_only/metrics_summary.csv"]);
  assert.deepEqual(mixed.outputCandidates, ["work_dirs/metadata_only/metrics_summary.csv"]);
  assert.ok(mixed.outputSignals.some((item) => item.includes("metrics_summary.csv")));
});

test("Hub Agent output gate and adapter policy reject metadata-only candidates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-metadata-candidate-"));
  const root = path.join(tmp, "project");
  fs.mkdirSync(path.join(root, "experiments", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, "experiments", "plans", "metadata.yaml"), metadataPlan(), "utf8");
  fs.writeFileSync(path.join(root, "experiments", "simple_project.yaml"), [
    "outputs:",
    "  candidateJson:",
    "    - work_dirs/metadata_only/status.json",
    "    - work_dirs/metadata_only/artifact_manifest.json",
  ].join("\n"), "utf8");

  const source = readSource("src/clusterAgentRuntime.ts");
  const agentPath = path.join(tmp, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(source), "utf8");
  const script = path.join(tmp, "check.py");
  fs.writeFileSync(script, [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', ${JSON.stringify(agentPath)})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(root)}`,
    "plan = 'experiments/plans/metadata.yaml'",
    "policy = agent.read_project_metric_policy(root)",
    "print(json.dumps({",
    "  'gate': agent.plan_output_capture_evidence(root, plan),",
    "  'declared': agent.plan_declared_result_candidates(root, plan),",
    "  'policy': agent.policy_explicit_result_candidates(policy),",
    "  'status': agent.parseable_result_candidate('work_dirs/metadata_only/status.json'),",
    "  'manifest': agent.parseable_result_candidate('work_dirs/metadata_only/artifact_manifest.json'),",
    "  'internal': agent.parseable_result_candidate('simple_cluster/results/by_plan/metadata/statistics.json'),",
    "}))",
  ].join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());
  assert.equal(payload.gate.ok, false);
  assert.deepEqual(payload.gate.expectedResults, []);
  assert.deepEqual(payload.declared, []);
  assert.deepEqual(payload.policy, []);
  assert.equal(payload.status, "");
  assert.equal(payload.manifest, "");
  assert.equal(payload.internal, "");
});

test("stdout and stderr stay valid evidence but cannot generate structured result records", () => {
  const agentPath = path.resolve(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = [
    'import importlib.util, pathlib, tempfile',
    'spec = importlib.util.spec_from_file_location("agent", pathlib.Path(' + JSON.stringify(agentPath) + '))',
    'agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)',
    'with tempfile.TemporaryDirectory() as root:',
    '    output = pathlib.Path(root, "work_dirs/demo")',
    '    output.mkdir(parents=True)',
    '    csv_rel = "work_dirs/demo/metrics_summary.csv"',
    '    stdout_rel = "work_dirs/demo/stdout.log"',
    '    stderr_rel = "work_dirs/demo/stderr.log"',
    '    (output / "metrics_summary.csv").write_text("experiment_id,suite,run_key,dataset,split,seed,metric,value\\ne1,demo,r1,d,test,7,accuracy,0.91\\n", encoding="utf-8")',
    '    (output / "stdout.log").write_text("accuracy: 0.99\\n", encoding="utf-8")',
    '    (output / "stderr.log").write_text("accuracy: 0.10\\n", encoding="utf-8")',
    '    assert agent.parseable_result_candidate(stdout_rel) == stdout_rel',
    '    assert agent.parseable_result_candidate(stderr_rel) == stderr_rel',
    '    assert agent.structured_result_candidate(stdout_rel) == ""',
    '    assert agent.structured_result_candidate(stderr_rel) == ""',
    '    assert agent.structured_result_candidate("work_dirs/demo/summary.txt")',
    '    assert stdout_rel not in agent.discover_result_files(root)',
    '    assert stderr_rel not in agent.discover_result_files_under(root, "work_dirs/demo")',
    '    assert stdout_rel not in agent.default_result_candidates_for_dir("work_dirs/demo")',
    '    summary = agent.parse_results_action(root)',
    '    assert summary["resultCount"] == 1, summary',
    '    assert summary["sources"] == [csv_rel], summary',
    '    selected = agent.parse_results_action(root, selected=[stdout_rel, stderr_rel, csv_rel])',
    '    assert selected["resultCount"] == 1, selected',
    '    assert selected["sources"] == [csv_rel], selected',
    'print("diagnostic logs excluded from structured results")',
  ].join("\n");
  const result = spawnSync("python", ["-c", script], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
