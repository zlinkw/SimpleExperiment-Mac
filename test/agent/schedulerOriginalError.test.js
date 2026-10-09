const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const runtime = path.join(root, "dist/runtime/cluster_scheduler.py");

test("failure output prints stderr only and omits wrapper metadata and stdout noise", () => {
  const script = `
import contextlib, importlib.util, io, json, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location("scheduler", pathlib.Path(${JSON.stringify(runtime)}))
scheduler = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scheduler
spec.loader.exec_module(scheduler)
with tempfile.TemporaryDirectory() as tmp:
    base = pathlib.Path(tmp)
    (base / "stderr.log").write_text("torch.OutOfMemoryError: CUDA out of memory\\n", encoding="utf-8")
    (base / "stdout.log").write_text("checkpoint: huge parameter dump\\n", encoding="utf-8")
    (base / "run_wrapper_report.json").write_text(json.dumps({"error": "secret context-json parameter dump"}), encoding="utf-8")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        shown = scheduler.surface_original_error(types.SimpleNamespace(output_dir=str(base)), "train")
    text = out.getvalue()
assert shown is True
assert "torch.OutOfMemoryError: CUDA out of memory" in text, text
assert "checkpoint: huge parameter dump" not in text, text
assert "secret context-json parameter dump" not in text, text
assert text.rstrip().endswith("========== end stderr.log =========="), text
print("ok")
`;
  const result = spawnSync("python", ["-X", "utf8", "-c", script], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("handled child failure exits nonzero without re-raising CalledProcessError", () => {
  const source = readSource("src/clusterSchedulerRuntime.ts");
  const block = source.slice(source.indexOf("def run_job(job:"), source.indexOf("def run_job_mode("));
  assert.match(block, /except subprocess\.CalledProcessError as exc:/);
  assert.match(block, /raise SystemExit\(_failed_process_exit_code\(exc\)\) from None/);
  assert.doesNotMatch(block, /surface_original_error\(job, "(?:train|test)"\)\s+raise\r?\n/);
});

test("retraining the same output directory reports only the current failed attempt", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-original-error-"));
  const scriptPath = path.join(tempRoot, "failure-report.py");
  const script = `
import contextlib, importlib.util, io, pathlib, subprocess, sys, tempfile, types
spec = importlib.util.spec_from_file_location("scheduler", pathlib.Path(${JSON.stringify(runtime)}))
scheduler = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scheduler
spec.loader.exec_module(scheduler)
with tempfile.TemporaryDirectory() as tmp:
    base = pathlib.Path(tmp)
    (base / "stderr.log").write_text("OLD CUDA out of memory\\n", encoding="utf-8")
    (base / "stdout.log").write_text("OLD training output\\n", encoding="utf-8")
    job = scheduler.Job(0, "suite", "case", 1, {}, str(base), str(base / "results.csv"), "train", "", "", False, "", {}, {})
    args = types.SimpleNamespace(resume=False, mode="train", gpu_ids="", worker_id="worker-a", overwrite=False, overwrite_existing=False, debug_mode=False)
    scheduler.render_command = lambda *unused: ["fake"]
    scheduler.wrap_command = lambda command, *unused: command
    def fail_current(command, env, cwd=None):
        with (base / "stderr.log").open("a", encoding="utf-8") as stream:
            stream.write("CURRENT invalid tensor shape\\n")
        raise subprocess.CalledProcessError(1, command)
    scheduler.run_command = fail_current
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            scheduler.run_job(job, args)
        except SystemExit as exc:
            assert exc.code == 1
    text = out.getvalue()
    assert "CURRENT invalid tensor shape" in text, text
    assert "OLD CUDA out of memory" not in text, text
    def fail_without_new_stderr(command, env, cwd=None):
        with (base / "stdout.log").open("a", encoding="utf-8") as stream:
            stream.write("CURRENT process failed before stderr opened\\n")
        raise subprocess.CalledProcessError(1, command)
    scheduler.run_command = fail_without_new_stderr
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            scheduler.run_job(job, args)
        except SystemExit as exc:
            assert exc.code == 1
    text = out.getvalue()
    assert "CURRENT process failed before stderr opened" in text, text
    assert "CURRENT invalid tensor shape" not in text, text
    assert "OLD CUDA out of memory" not in text, text
    assert "OLD CUDA out of memory" in (base / "stderr.log").read_text(encoding="utf-8")
print("ok")
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const result = spawnSync("python", ["-X", "utf8", scriptPath], {
      encoding: "utf8", cwd: root, timeout: 10000, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
