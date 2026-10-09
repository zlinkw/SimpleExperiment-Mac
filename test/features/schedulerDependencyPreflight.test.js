const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const schedulerPath = path.join(root, "dist/runtime/cluster_scheduler.py");
const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
const agentSource = readSource("src/clusterAgentRuntime.ts");
const schedulerSource = readSource("src/clusterSchedulerRuntime.ts");
const extensionSource = readSource("src/extension.ts");
const panelSource = readSource("src/ui/PanelHtml.ts");
const probeSource = readSource("src/tunnel/XshellTunnelPortProbe.ts");
const utf8PythonEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
function runPython(args, env = utf8PythonEnv) {
  return spawnSync("python", args, { encoding: "utf8", env, timeout: 10000, windowsHide: true });
}

test("scheduler reports actionable PyYAML guidance without a traceback", () => {
  const readyCheck = runPython([schedulerPath, "--check-dependencies-json"]);
  assert.equal(readyCheck.status, 0, readyCheck.stderr || readyCheck.stdout);
  const ready = JSON.parse(readyCheck.stdout.trim());
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.missingModules, []);
  assert.equal(ready.installCommand, "");

  const check = runPython(["-S", schedulerPath, "--check-dependencies-json"]);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const status = JSON.parse(check.stdout.trim());
  assert.equal(status.ok, false);
  assert.equal(status.environment.kind, "system_python");
  assert.deepEqual(status.missingModules, [{ module: "yaml", package: "PyYAML" }]);
  assert.match(status.installCommand, /-m pip install PyYAML$/);
  assert.match(status.message, /当前执行环境：系统 Python/);
  assert.match(status.message, /缺失模块：yaml \(PyYAML\)/);
  assert.doesNotMatch(status.message, /Traceback/);

  const validation = runPython(["-S", schedulerPath, "--validate-plan", "--plan", "missing.yaml"]);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr, /Scheduler 依赖预检失败/);
  assert.match(validation.stderr, /安装命令：/);
  assert.doesNotMatch(validation.stderr, /Traceback/);
});

test("dependency guidance targets an explicitly configured Conda environment", () => {
  const check = runPython(["-S", schedulerPath, "--check-dependencies-json"], {
    ...utf8PythonEnv, SIMPLE_EXPERIMENT_CONDA_ENV: "research", SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV: "1",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const status = JSON.parse(check.stdout.trim());
  assert.equal(status.ok, false);
  assert.equal(status.environment.kind, "conda");
  assert.equal(status.environment.name, "research");
  assert.equal(status.installCommand, "conda run -n research python -m pip install PyYAML");
  assert.match(status.message, /当前执行环境：Conda research/);
});

test("Agent propagates dependency failures before validation, preview, or Worker launch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-dependency-"));
  const fixture = path.join(directory, "scheduler.py");
  fs.writeFileSync(fixture, [
    "import json, sys",
    "if '--check-dependencies-json' in sys.argv:",
    "    print(json.dumps({'ok': False, 'message': '缺少 yaml；安装命令：python -m pip install PyYAML'}))",
    "else:",
    "    raise SystemExit('scheduler should not run')",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(directory, "plan.yaml"), "mode: train\n", "utf8");
  const gateStart = agentSource.indexOf("def require_scheduler_dependencies(root, scheduler, env=None):");
  const gateEnd = agentSource.indexOf("\ndef scheduler_validate_json", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "scheduler dependency gate missing");
  const workerStart = agentSource.indexOf("def _execute_worker_command_unfenced(root, command, worker_id):");
  const workerEnd = agentSource.indexOf("\ndef execute_worker_command", workerStart);
  const worker = agentSource.slice(workerStart, workerEnd);
  const dependencyGate = worker.indexOf("require_scheduler_dependencies(project_dir, scheduler_path, env)");
  const launchPositions = [worker.indexOf("start_job_in_gpu_pane("), worker.indexOf("start_simple_tmux_command(")].filter((index) => index >= 0);
  assert.ok(dependencyGate >= 0 && launchPositions.length > 0 && launchPositions.every((index) => dependencyGate < index),
    "dependency preflight must run before any Worker launch");
  const entryPointStart = agentSource.indexOf("def execute_worker_command(root, command, worker_id):");
  const entryPointEnd = agentSource.indexOf("\ndef worker_command_plan_mode", entryPointStart);
  assert.match(agentSource.slice(entryPointStart, entryPointEnd), /return _execute_worker_command_unfenced\(root, command, worker_id\)/);
  const script = [
    "import json, subprocess, sys",
    "def scheduler_dependency_status(root, scheduler, env=None):",
    "    result = subprocess.run([sys.executable, scheduler, '--check-dependencies-json'], capture_output=True, text=True, timeout=5)",
    "    return json.loads(result.stdout)",
    agentSource.slice(gateStart, gateEnd).trimEnd(),
    "try:",
    `    require_scheduler_dependencies(${JSON.stringify(directory)}, ${JSON.stringify(fixture)})`,
    "except Exception as exc:",
    "    print(json.dumps({'error': str(exc)}, ensure_ascii=False))",
  ].join("\n");
  const scriptPath = path.join(directory, "dependency_gate.py");
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = runPython([scriptPath]);
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.match(payload.error, /python -m pip install PyYAML/);
  const validate = agentSource.slice(agentSource.indexOf("def scheduler_validate_json"), agentSource.indexOf("def dry_run_preview_action"));
  const preview = agentSource.slice(agentSource.indexOf("def dry_run_preview_action"), agentSource.indexOf("def selected_worker_id"));
  assert.match(validate, /require_scheduler_dependencies\(root, scheduler, env\)/);
  assert.match(preview, /require_scheduler_dependencies\(root, scheduler\)/);
  assert.match(agentSource, /simple_conda_activation_script\(\)\} && exec/);
  assert.match(schedulerSource, /simple_conda_activation_script\(env\)\} && exec/);
});

test("Agent health reports scheduler dependency readiness before plan actions", () => {
  const healthStart = agentSource.indexOf("def api_health(root, mode=\"realtime\"):");
  const healthEnd = agentSource.indexOf("\ndef api_version", healthStart);
  const dependenciesStart = agentSource.indexOf("def scheduler_dependency_health(root, max_age_seconds=30):");
  const dependenciesEnd = agentSource.indexOf("\ndef require_scheduler_dependencies", dependenciesStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.ok(dependenciesStart >= 0 && dependenciesEnd > dependenciesStart);
  assert.match(agentSource.slice(healthStart, healthEnd), /"schedulerDependencies": scheduler_dependency_health\(root\)/);
  assert.match(agentSource.slice(dependenciesStart, dependenciesEnd), /status = scheduler_dependency_status\(root, scheduler, env\)/);
  assert.match(agentSource.slice(dependenciesStart, dependenciesEnd), /SCHEDULER_DEPENDENCY_CACHE/);
});

test("endpoint probes, onboarding, and UI retain scheduler dependency guidance", () => {
  assert.match(probeSource, /schedulerDependencies: health\.schedulerDependencies/);
  assert.match(extensionSource, /schedulerDependencies: compactSchedulerDependenciesForWebview\(probe\.schedulerDependencies\)/);
  assert.match(extensionSource, /const dependencyIssues = \[\{ label: "Hub", probe: hub \}, \.\.\.workers\]/);
  assert.match(extensionSource, /projectBootstrapEndpointReadiness\(\{[\s\S]*hubSchedulerDependencies/);
  assert.match(panelSource, /const dependencyRows = hubRequired \? \[\{ label: "Hub", dependency: hubProbe\.schedulerDependencies \}\] : \[\]/);
  assert.match(panelSource, /Scheduler 依赖缺失/);
  assert.match(panelSource, /installCommand/);
  assert.match(panelSource, /renderSchedulerDependencyStatus/);
});
