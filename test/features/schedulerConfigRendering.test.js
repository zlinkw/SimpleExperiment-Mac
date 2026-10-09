const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");
const schedulerRuntime = path.join(root, "dist", "runtime", "cluster_scheduler.py");

test("scheduler resolves config inheritance and renders nested job config values", (t) => {
  const python = process.env.PYTHON || "python";
  const dependencies = spawnSync(python, ["-c", "import yaml"], { encoding: "utf8" });
  if (dependencies.status !== 0) {
    t.skip("python or PyYAML unavailable");
    return;
  }

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-scheduler-config-"));
  const variants = path.join(project, "configs", "variants");
  fs.mkdirSync(variants, { recursive: true });
  fs.writeFileSync(path.join(project, "configs", "base.yaml"), "model:\n  depth: 18\n  dropout: 0.1\npaths:\n  root: inherited\n", "utf8");
  fs.writeFileSync(path.join(variants, "child.yaml"), "defaults_from: ../base.yaml\nmodel:\n  dropout: 0.25\n", "utf8");
  fs.writeFileSync(path.join(project, "configs", "legacy-child.yaml"), "defaults_from: configs/base.yaml\nmodel:\n  depth: 34\n", "utf8");
  fs.writeFileSync(path.join(project, "configs", "cycle-a.yaml"), "defaults_from: cycle-b.yaml\n", "utf8");
  fs.writeFileSync(path.join(project, "configs", "cycle-b.yaml"), "defaults_from: cycle-a.yaml\n", "utf8");

  const script = String.raw`
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location("cluster_scheduler", ${JSON.stringify(schedulerRuntime)})
scheduler = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scheduler
spec.loader.exec_module(scheduler)
os.chdir(${JSON.stringify(project)})

plan = {
    "_file": "experiments/plans/demo.yaml",
    "suite": "demo",
    "seeds": [7],
    "base_config": "configs/variants/child.yaml",
    "config": {
        "paths": {"run": "runs/{suite}/{case}/{seed}"},
        "labels": ["{experiment_name}", "seed-{seed}"],
    },
    "naming": {"experiment_name": "{suite}/{case}/seed_{seed}"},
    "cases": [{
        "case": "alpha",
        "config": {"paths": {"result": "{output_dir}/metrics.csv"}},
        "overrides": {"tag": "{job_name}"},
    }],
}
_, jobs = scheduler.build_jobs(plan)
job = jobs[0]
legacy = scheduler.load_config("configs/legacy-child.yaml")

try:
    scheduler.load_config("configs/cycle-a.yaml")
    cycle_error = ""
except ValueError as exc:
    cycle_error = str(exc)

print(json.dumps({
    "depth": job.config["model"]["depth"],
    "dropout": job.config["model"]["dropout"],
    "legacyDepth": legacy["model"]["depth"],
    "legacyDropout": legacy["model"]["dropout"],
    "inheritedRoot": job.config["paths"]["root"],
    "runPath": job.config["paths"]["run"],
    "resultPath": job.config["paths"]["result"],
    "labels": job.config["labels"],
    "tag": job.config["tag"],
    "outputDir": job.config["runtime"]["output_dir"],
    "cycleError": cycle_error,
}, ensure_ascii=False))
`;

  const run = spawnSync(python, ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.depth, 18);
  assert.equal(result.dropout, 0.25);
  assert.equal(result.legacyDepth, 34);
  assert.equal(result.legacyDropout, 0.1);
  assert.equal(result.inheritedRoot, "inherited");
  assert.equal(result.runPath, "runs/demo/alpha/7");
  assert.equal(result.resultPath, "work_dirs/multirun/demo/0_alpha_seed7/metrics.csv");
  assert.deepEqual(result.labels, ["demo/alpha/seed_7", "seed-7"]);
  assert.equal(result.tag, "0_alpha_seed7");
  assert.equal(result.outputDir, "work_dirs/multirun/demo/0_alpha_seed7");
  assert.match(result.cycleError, /defaults_from.*循环/);
  assert.match(result.cycleError, /cycle-a\.yaml.*cycle-b\.yaml.*cycle-a\.yaml/);
});

test("scheduler source wires recursive config rendering after case overrides", () => {
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(source, /def render_config_templates\(value: Any, values: dict\[str, Any\]\) -> Any:/);
  assert.match(source, /for key, value in overrides\.items\(\):\r?\n {16}set_dotted\(cfg, str\(key\), value\)\r?\n {12}cfg = render_config_templates\(cfg, values\)/);
});
