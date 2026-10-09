const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const schedulerRuntime = path.join(root, "dist/runtime/cluster_scheduler.py");

function runPythonScript(script, options = {}) {
  const scriptPath = path.join(os.tmpdir(), `output-interface-${process.pid}.py`);
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return spawnSync("python", [scriptPath], { encoding: "utf8", timeout: 10000, windowsHide: true, ...options });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function write(relative, content) {
  return (project) => {
    const target = path.join(project, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
}

function baseProject(...writers) {
  return (project) => {
    write("configs/base.yaml", "{}\n")(project);
    write("experiments/plans/smoke.yaml", [
      "suite: smoke",
      "mode: test",
      "base_config: configs/base.yaml",
      "seeds: [0]",
      "paper:",
      "  result_csv: work_dirs/smoke/metrics_summary.csv",
      "runner:",
      "  test_command: python test.py --output-dir work_dirs/smoke",
      "cases:",
      "  - case: baseline",
    ].join("\n"))(project);
    for (const item of writers) item(project);
  };
}

function createProject(...writers) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-output-interface-"));
  baseProject(...writers)(project);
  return project;
}

test("scheduler accepts a configured run wrapper", () => {
  const project = createProject(
    write("experiments/simple_project.yaml", "adapter:\n  runWrapper: experiments/simple_adapter/run_wrapper.py\n"),
    write("experiments/simple_adapter/run_wrapper.py", "print('wrapper')\n"),
  );
  const result = spawnSync("python", [schedulerRuntime, "--validate-plan", "--plan", "experiments/plans/smoke.yaml"], {
    cwd: project,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputInterface.ok, true);
  assert.equal(payload.outputInterface.rows[0].channels[0].type, "run_wrapper");
});

test("scheduler accepts a direct AST-verified adapter call", () => {
  const project = createProject(write("test.py", [
    "from experiments.simple_adapter import collect_outputs",
    "",
    "def main():",
    "    collect_outputs('work_dirs/smoke')",
    "",
    "main()",
  ].join("\n")));
  const result = spawnSync("python", [schedulerRuntime, "--validate-plan", "--plan", "experiments/plans/smoke.yaml"], {
    cwd: project,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputInterface.ok, true);
  assert.equal(payload.outputInterface.rows[0].channels[0].type, "adapter_call");
});

test("dry-run worker temp cleanup only removes exact runtime-generated files", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-temp-cleanup-"));
  const script = [
    "import importlib.util, json, os, sys, time",
    `spec = importlib.util.spec_from_file_location('cluster_agent', ${JSON.stringify(path.join(root, "dist/runtime/cluster_agent.py"))})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(project)}`,
    "actions = os.path.dirname(agent.state_child_path(root, 'actions', ''))",
    "old = os.path.join(actions, f'dry-run-workers-{int(time.time())}-{\"a\" * 12}.json')",
    "new = os.path.join(actions, f'dry-run-workers-{int(time.time())}-{\"b\" * 12}.json')",
    "other = os.path.join(actions, 'important.json')",
    "for path in (old, new, other): open(path, 'w', encoding='utf-8').write('{}')",
    "os.utime(old, (time.time() - 86400 * 2, time.time() - 86400 * 2))",
    "report = agent.cleanup_dry_run_worker_temp_files(root)",
    "print(json.dumps({'report': report, 'old': os.path.exists(old), 'new': os.path.exists(new), 'other': os.path.exists(other)}))",
  ].join("\n");
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.report.removedCount, 0, "automatic cleanup must not delete without a path-specific confirmation");
  assert.equal(payload.old, true);
  assert.equal(payload.new, true);
  assert.equal(payload.other, true);
});

test("TensorBoard final scalars are converted to the standard result contract", () => {
  const project = createProject(write("test.py", [
    "from torch.utils.tensorboard import SummaryWriter",
    "",
    "writer = SummaryWriter('work_dirs/smoke')",
    "writer.add_scalar('AUC', 0.91, 0)",
    "writer.close()",
  ].join("\n")));
  fs.mkdirSync(path.join(project, "work_dirs", "smoke"), { recursive: true });
  fs.writeFileSync(path.join(project, "work_dirs", "smoke", "events.out.tfevents.test"), "", "utf8");
  const script = [
    "import importlib.util, json, os, sys, types",
    `root = ${JSON.stringify(project)}`,
    "os.chdir(root)",
    "class Scalar:",
    "    def __init__(self): self.value = 0.91; self.step = 7",
    "class Accumulator:",
    "    def __init__(self, path, size_guidance=None): pass",
    "    def Reload(self): pass",
    "    def Tags(self): return {'scalars': ['AUC']}",
    "    def Scalars(self, tag): return [Scalar()]",
    "fake = types.ModuleType('tensorboard')",
    "backend = types.ModuleType('tensorboard.backend')",
    "processing = types.ModuleType('tensorboard.backend.event_processing')",
    "accumulator = types.ModuleType('tensorboard.backend.event_processing.event_accumulator')",
    "accumulator.EventAccumulator = Accumulator",
    "fake.backend = backend",
    "backend.event_processing = processing",
    "processing.event_accumulator = accumulator",
    "sys.modules.update({'tensorboard': fake, 'tensorboard.backend': backend, 'tensorboard.backend.event_processing': processing, 'tensorboard.backend.event_processing.event_accumulator': accumulator})",
    `spec = importlib.util.spec_from_file_location('cluster_scheduler', ${JSON.stringify(schedulerRuntime)})`,
    "scheduler = importlib.util.module_from_spec(spec)",
    "sys.modules['cluster_scheduler'] = scheduler",
    "spec.loader.exec_module(scheduler)",
    "scheduler.tensorboard_conversion_available = lambda: True",
    "os.makedirs('experiments/results', exist_ok=True)",
    "formal = 'experiments/results/baseline.csv'",
    "open(formal, 'w', encoding='utf-8').write('protocol_version,metric,value\\n2,AUC,0.8\\n')",
    "job = scheduler.Job(index=0, suite='smoke', case='baseline', seed=0, config={'seed': 0}, output_dir='work_dirs/smoke', result_csv=formal, train_command='', test_command='python test.py --output-dir work_dirs/smoke', run_wrapper='', wrap_output=False, base_config_path='configs/base.yaml', template_values={'experiment_id':'smoke/baseline/seed_0','method':'baseline','dataset':'demo','split':'test'}, result_aliases={})",
    "report = scheduler.collect_tensorboard_metrics(job)",
    "csv_text = open('work_dirs/smoke/metrics_summary.csv', encoding='utf-8').read()",
    "print(json.dumps({'report': report, 'csv': csv_text, 'scalar_csv': open('work_dirs/smoke/tensorboard_scalars.csv', encoding='utf-8').read(), 'formal': open(formal, encoding='utf-8').read(), 'env': os.path.exists('work_dirs/smoke/env_snapshot.json'), 'config': os.path.exists('work_dirs/smoke/config_snapshot.yaml')}))",
  ].join("\n");
  const result = runPythonScript(script, { cwd: project, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.report.ok, true);
  assert.equal(payload.report.metricCount, 1);
  assert.equal(payload.report.addedRows, 1);
  assert.match(payload.csv, /AUC,0\.91,/);
  assert.match(payload.scalar_csv, /AUC,0\.91,/);
  assert.equal(payload.formal, "protocol_version,metric,value\n2,AUC,0.8\n");
  assert.equal(payload.env, true);
  assert.equal(payload.config, true);
});
