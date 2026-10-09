const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function extractAgent() { return readBuiltAgentRuntime(); }

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("Agent enriches experiment traces with unambiguous Plan revision provenance", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  const built = fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"), "utf8");
  for (const text of [source, built]) {
    assert.match(text, /def enrich_trace_plan_provenance\(root, rows, scheduler=None\):/);
    assert.match(text, /def collect_traces\(root, scheduler=None\):/);
    assert.match(text, /traces = collect_traces\([^,]+, scheduler\)/);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-trace-plan-"));
  const root = path.join(tmp, "project");
  const agentPath = path.join(tmp, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(source), "utf8");
  writeJson(path.join(root, "simple_cluster", "experiment_index.json"), [
    { run_id: "a", hub_job_dir: "work_dirs/a", status: "completed" },
    { run_id: "b", worker_job_dir: "/srv/project/work_dirs/b", results_csv: "/srv/project/work_dirs/b/metrics.csv", status: "completed" },
    { run_id: "c", hub_job_dir: "work_dirs/c", status: "archived" },
    { run_id: "shared", hub_job_dir: "work_dirs/shared", status: "completed" },
    { run_id: "legacy", hub_job_dir: "work_dirs/legacy", status: "completed" },
  ]);
  const schedulerDir = path.join(root, "simple_cluster", "tmp", "cluster_scheduler");
  writeJson(path.join(schedulerDir, "a_state.json"), { plan: "experiments/plans/a.yaml", planRevision: "rev-a", completed_experiments: [{ output_dir: "work_dirs/a" }] });
  writeJson(path.join(schedulerDir, "b_state.json"), { plan: "experiments/plans/b.yaml", planRevision: "rev-b", completed_experiments: [{ output_dir: "work_dirs/b" }] });
  writeJson(path.join(schedulerDir, "shared-x_state.json"), { plan: "experiments/plans/x.yaml", planRevision: "rev-x", completed_experiments: [{ output_dir: "work_dirs/shared" }] });
  writeJson(path.join(schedulerDir, "shared-y_state.json"), { plan: "experiments/plans/y.yaml", planRevision: "rev-y", completed_experiments: [{ output_dir: "work_dirs/shared" }] });

  const script = path.join(tmp, "check.py");
  fs.writeFileSync(script, [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', ${JSON.stringify(agentPath)})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(root)}`,
    "agent.mark_archive_state(root, ['work_dirs/c'], 'archive-artifacts', 'experiments/plans/c.yaml', 'rev-c')",
    "rows = agent.collect_traces(root, agent.collect_scheduler(root))",
    "print(json.dumps({str(row.get('run_id')): {'plan': row.get('planFile'), 'revision': row.get('planRevision')} for row in rows}))",
  ].join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());
  assert.deepEqual(payload.a, { plan: "experiments/plans/a.yaml", revision: "rev-a" });
  assert.deepEqual(payload.b, { plan: "experiments/plans/b.yaml", revision: "rev-b" });
  assert.deepEqual(payload.c, { plan: "experiments/plans/c.yaml", revision: "rev-c" });
  assert.deepEqual(payload.shared, { plan: null, revision: null });
  assert.deepEqual(payload.legacy, { plan: null, revision: null });
});

