const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function pyString(value) {
  return JSON.stringify(String(value));
}

test("remote terminal events keep raw metrics intact and create no rebuilt results or caches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-run-terminal-"));
  const runtime = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const plans = [
    ["completed", "operation_completed", "completed"],
    ["failed", "operation_failed", "failed"],
    ["cancelled", "operation_failed", "cancelled"],
  ];
  for (const [name] of plans) {
    write(path.join(root, "experiments", "plans", `${name}.yaml`), [
      `suite: ${name}`,
      "mode: test",
      "paper:",
      `  result_csv: experiments/results/${name}.csv`,
    ].join("\n") + "\n");
    write(path.join(root, "experiments", "results", `${name}.csv`), [
      "experiment_id,suite,method,dataset,split,seed,metric,value",
      `${name}-run,${name},ours,demo,test,0,AUC,0.9`,
    ].join("\n") + "\n");
  }
  write(path.join(root, "experiments", "simple_project.yaml"), [
    "project: multi-plan",
    "taskType: classification",
    "primaryMetric: AUC",
    "candidateCsv:",
    "  - experiments/results/*.csv",
  ].join("\n") + "\n");
  const script = path.join(root, "verify.py");
  write(script, [
    "import json, os, sys",
    `sys.path.insert(0, ${pyString(path.join(__dirname, "../_helpers"))})`,
    "from extractRuntimeFunctions import extract_runtime_functions",
    `agent = extract_runtime_functions(${pyString(runtime)}, ['now_iso', 'maybe_auto_run_completion_pipeline', 'read_results_summary', 'read_auto_completion_state'])`,
    `root = ${pyString(root)}`,
    `plans = ${JSON.stringify(plans)}`,
    "rows = []",
    "for name, event_type, status in plans:",
    "    plan = f'experiments/plans/{name}.yaml'",
    "    event = {'schemaVersion': 1, 'seq': len(rows) + 1, 'generatedAt': agent.now_iso(), 'source': 'hub_agent', 'type': event_type, 'operationId': f'op-{name}', 'payload': {'action': 'run-plan', 'status': status, 'planFile': plan, 'schedulerFinished': True}}",
    "    before = sorted(os.path.relpath(os.path.join(base, file), root) for base, _, files in os.walk(root) for file in files)",
    "    original = open(os.path.join(root, 'experiments', 'results', name + '.csv'), encoding='utf-8').read()",
    "    result = agent.maybe_auto_run_completion_pipeline(root, event)",
    "    duplicate = agent.maybe_auto_run_completion_pipeline(root, event)",
    "    after = sorted(os.path.relpath(os.path.join(base, file), root) for base, _, files in os.walk(root) for file in files)",
    "    assert before == after and original == open(os.path.join(root, 'experiments', 'results', name + '.csv'), encoding='utf-8').read()",
    "    rows.append({'result': result, 'duplicate': duplicate})",
    "print(json.dumps(rows))",
  ].join("\n"));
  const result = spawnSync("python", ["-X", "utf8", script], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.result, null);
    assert.equal(row.duplicate, null);
  }
  const scheduler = fs.readFileSync(path.join(__dirname, "../../src/clusterSchedulerRuntime.legacy.ts"), "utf8");
  const hook = scheduler.slice(scheduler.indexOf("def run_agent_completion_pipeline("), scheduler.indexOf("def append_scheduler_operation_event("));
  assert.match(hook, /return None/);
  assert.doesNotMatch(hook, /exec_module|append_log|parse_results_action/);
});
