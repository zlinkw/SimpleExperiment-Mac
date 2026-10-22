const { writePythonFixture } = require("../_helpers/isolatedPythonFixture");
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
  if (args.includes(schedulerPath)) {
    const script = "import sys, json\nsys.path.insert(0, " + JSON.stringify(path.join(root,"test/_helpers")) + ")\nfrom extractRuntimeFunctions import extract_runtime_functions\nscheduler = extract_runtime_functions(" + JSON.stringify(schedulerPath) + ", ['scheduler_dependency_status', 'require_scheduler_dependencies'])\nif '--check-dependencies-json' in sys.argv:\n    print(json.dumps(scheduler.scheduler_dependency_status()))\nelse:\n    scheduler.require_scheduler_dependencies()\n";
    args = args.map(value => value === schedulerPath ? writePythonFixture(script, "dependency-functions-") : value);
  }
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
  const dependencyGate = worker.indexOf("verified_formal_job_command(project_dir, command)");
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
  // Retain scheduler stand-in and diagnostic evidence.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.match(payload.error, /python -m pip install PyYAML/);
  const currentGate = [
    "import sys, json",
    "from types import SimpleNamespace",
    "sys.path.insert(0, " + JSON.stringify(path.join(root,"test/_helpers")) + ")",
    "from extractRuntimeFunctions import extract_runtime_functions",
    "agent = extract_runtime_functions(" + JSON.stringify(agentPath) + ", ['verified_formal_job_command', 'scheduler_validate_json', 'dry_run_preview_action'])",
    "message = '缺少 yaml；安装命令：python -m pip install PyYAML'",
    "agent.cluster_scheduler_path = lambda root: 'fixture-scheduler.py'",
    "agent.formal_job_path_capable = agent.task_shell_environment_capable = lambda root: True",
    "agent.formal_job_command_env = lambda command: {}",
    "agent.simple_runtime_python = lambda env: sys.executable",
    "agent.simple_conda_wrapped_args = lambda args, env: args",
    "agent.job_shell_environment_prefix = lambda *args: ''",
    "agent.subprocess_inactivity_run = lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr=message, stdout='')",
    "agent.cached_scheduler_validation = lambda *args: None",
    "agent.plan_structural_validation_key = lambda *args: ''",
    "agent.scheduler_capture = lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr=message, stdout='')",
    "agent.state_child_path = lambda *args: 'fixture-worker-input.json'",
    "agent.atomic_write = lambda *args: None",
    "agent.availability_cache_path = agent.agent_dir = lambda *args: 'fixture-state'",
    "command = dict(resultPathPolicy='declared', outputDir='outputs/job', mode='train', planFile='plans/a.yaml', experimentIndex=0)",
    "rejected = []",
    "for invoke in (lambda: agent.verified_formal_job_command('/fixture', command), lambda: agent.scheduler_validate_json('/fixture', 'scheduler', 'plans/a.yaml'), lambda: agent.dry_run_preview_action('/fixture', 'plans/a.yaml', [], operation_id='preview-owner')):",
    "    try: invoke()",
    "    except (ValueError, RuntimeError) as exc:",
    "        assert message in str(exc), str(exc)",
    "        rejected.append(str(exc))",
    "    else: raise AssertionError('dependency failure became a successful preflight')",
    "print(json.dumps({'rejected':len(rejected), 'remoteOperations':0}))",
  ].join("\n");
  const currentResult = runPython([writePythonFixture(currentGate, "current-dependency-gates-")]);
  assert.equal(currentResult.status, 0, currentResult.stderr || currentResult.error?.message);
  assert.deepEqual(JSON.parse(currentResult.stdout), { rejected: 3, remoteOperations: 0 });

  const validate = agentSource.slice(agentSource.indexOf("def scheduler_validate_json"), agentSource.indexOf("def dry_run_preview_action"));
  const preview = agentSource.slice(agentSource.indexOf("def dry_run_preview_action"), agentSource.indexOf("def selected_worker_id"));
  assert.match(validate, /result = scheduler_capture\(root, scheduler,/);
  assert.match(preview, /result = scheduler_capture\(root, scheduler, scheduler_args\)/);
  assert.match(agentSource, /return task_shell_args\(args, source, simple_runtime_python\(source\)\)/);
  assert.match(schedulerSource, /return task_shell_args\(args, env, runtime_python_command\(env\)\)/);
});

test("Agent health reports scheduler dependency readiness before plan actions", () => {
  const healthStart = agentSource.indexOf("def api_health(root, mode=\"realtime\"):");
  const healthEnd = agentSource.indexOf("\ndef api_version", healthStart);
  const dependenciesStart = agentSource.indexOf("def scheduler_dependency_health(root, max_age_seconds=30):");
  const dependenciesEnd = agentSource.indexOf("\ndef require_scheduler_dependencies", dependenciesStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.ok(dependenciesStart >= 0 && dependenciesEnd > dependenciesStart);
  assert.match(agentSource.slice(healthStart, healthEnd), /"schedulerDependencies": \{"checked": False, "automatic": False, "scope": "agent", "reason": "research_environment_owned_by_project"\}/);
  assert.doesNotMatch(agentSource.slice(healthStart, healthEnd), /scheduler_dependency_health\(root\)/);
  assert.match(agentSource.slice(dependenciesStart, dependenciesEnd), /status = scheduler_dependency_status\(root, scheduler, env\)/);
  assert.match(agentSource.slice(dependenciesStart, dependenciesEnd), /SCHEDULER_DEPENDENCY_CACHE/);
});

test("endpoint probes, onboarding, and UI retain scheduler dependency guidance", () => {
  assert.match(probeSource, /schedulerDependencies: health\.schedulerDependencies/);
  assert.match(extensionSource, /schedulerDependencies: compactSchedulerDependenciesForWebview\(probe\.schedulerDependencies\)/);
  assert.match(extensionSource, /const dependencyIssues = workers\.flatMap/);
  assert.match(extensionSource, /projectBootstrapEndpointReadiness\(\{[\s\S]*hubSchedulerDependencies/);
  assert.match(panelSource, /const dependencyRows = \[\];\s+workers\.forEach\(\(worker\) => dependencyRows\.push/);
  assert.match(panelSource, /Scheduler 依赖缺失/);
  assert.match(panelSource, /installCommand/);
  assert.match(panelSource, /renderSchedulerDependencyStatus/);
});
