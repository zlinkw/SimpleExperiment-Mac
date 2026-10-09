const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const runtime = path.join(__dirname, "../../dist/runtime/cluster_scheduler.py");

test("resume requires every per-job metric in the shared result CSV", () => {
  const script = `
import importlib.util, io, json, sys
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("scheduler_resume_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
job = SimpleNamespace(output_dir="work_dirs/case_seed42", result_csv="experiments/results/method.csv", case="case", seed=42)
summary = "metric,eval_protocol\\naccuracy,clean\\nroc_auc,p100_low\\n"
header = "job_dir,case,seed,metric,eval_protocol\\n"
first = "work_dirs/case_seed42,case,42,accuracy,clean\\n"
second = "work_dirs/case_seed42,case,42,roc_auc,p100_low\\n"
other = "work_dirs/other,case,43,roc_auc,p100_low\\n"
original_open = module.Path.open
def check(table):
    def fake_open(self, *args, **kwargs):
        return io.StringIO(summary if self.name == "metrics_summary.csv" else table)
    with patch.object(module.Path, "is_file", return_value=True), patch.object(module.Path, "open", fake_open):
        return module.result_table_covers_job(job)
print(json.dumps({"partial": check(header + first), "complete": check(header + first + second), "wrongJob": check(header + first + other), "badHeader": check("metric,value\\naccuracy,0.8\\n")}))
`;
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, ["-c", script, runtime], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    partial: false,
    complete: true,
    wrongJob: false,
    badHeader: false,
  });
});
