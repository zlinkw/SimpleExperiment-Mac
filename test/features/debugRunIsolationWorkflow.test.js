const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const schedulerRuntime = path.join(root, "dist/runtime/cluster_scheduler.py");
const agentRuntime = path.join(root, "dist/runtime/cluster_agent.py");
const schedulerSource = readSource("src/clusterSchedulerRuntime.ts");
const agentSource = readSource("src/clusterAgentRuntime.ts");
const extensionSource = readSource("src/extension.ts");
const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function runModeActionLabel(mode, formalLabel) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(panelSource, "runModeActionLabel") + "\nthis.check = runModeActionLabel;", sandbox);
  return sandbox.check(mode, formalLabel);
}

function runModeForButton(dataset, command, fallbackMode) {
  const sandbox = { SELECTED_PLAN_RUN_COMMANDS: new Set(["runPlan", "reproducePlan"]) };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(panelSource, "runModeForButton") + "\nthis.check = runModeForButton;", sandbox);
  return sandbox.check({ dataset }, command, fallbackMode);
}

test("Debug run controls are absent and stale submissions are rejected", () => {
  assert.doesNotMatch(panelSource, /data-run-mode="debug"|data-command="runDraftDebug"/);
  assert.match(panelSource, /payload\.debugMode = false/);
  assert.match(extensionSource, /if \(body\.debugMode === true\)\s*throw new Error\("Debug 运行模式已移除/);
  assert.match(agentSource, /if debug_mode:\s*return terminal_action\(root, action, operation_id, op_id, "failed", "Debug 运行模式已移除/);
  assert.match(schedulerSource, /if args\.debug_mode:\s*raise SystemExit\("Debug 运行模式已移除/);
});

test("Debug worker execution is rejected before any output is written", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-debug-run-"));
  fs.mkdirSync(path.join(project, "configs"), { recursive: true });
  fs.mkdirSync(path.join(project, "experiments", "plans"), { recursive: true });
  fs.writeFileSync(path.join(project, "configs", "base.yaml"), "{}\n", "utf8");
  fs.writeFileSync(path.join(project, "train_stage.py"), [
    "import argparse",
    "from pathlib import Path",
    "p = argparse.ArgumentParser()",
    "p.add_argument('--output-dir', required=True)",
    "p.add_argument('--result-csv', required=True)",
    "a = p.parse_args()",
    "out = Path(a.output_dir)",
    "out.mkdir(parents=True, exist_ok=True)",
    "(out / 'debug.marker').write_text('ok', encoding='utf-8')",
    "result = Path(a.result_csv)",
    "result.parent.mkdir(parents=True, exist_ok=True)",
    "result.write_text('metric,value\\nAUC,0.9\\n', encoding='utf-8')",
    "",
  ].join("\n"), "utf8");
  const plan = path.join(project, "experiments", "plans", "smoke.yaml");
  fs.writeFileSync(plan, [
    "suite: smoke",
    "mode: train",
    "base_config: configs/base.yaml",
    "seeds: [0, 1]",
    "runner:",
    "  train_command: python train_stage.py --output-dir work_dirs/hardcoded --result-csv experiments/results/hardcoded.csv",
    "paper:",
    "  result_csv: experiments/results/smoke.csv",
    "naming:",
    "  sweep_dir: work_dirs/{suite}",
    "cases:",
    "  - case: baseline",
    "",
  ].join("\n"), "utf8");

  const result = spawnSync("python", [schedulerRuntime, "--run-job", "--plan", plan, "--only-index", "0", "--debug-mode", "--debug-run-id", "debug-1"], { cwd: project, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr || result.stdout, /Debug 运行模式已移除/);
  const debugRoot = path.join(project, "simple_cluster", "debug_runs");
  assert.equal(fs.existsSync(debugRoot), false);
  assert.equal(fs.existsSync(path.join(project, "work_dirs")), false);
  assert.equal(fs.existsSync(path.join(project, "experiments", "results", "smoke.csv")), false);
  assert.equal(fs.existsSync(path.join(project, "experiments", "results", "hardcoded.csv")), false);
  assert.equal(fs.existsSync(path.join(project, "experiments", "results", "jobs.csv")), false);
});

test("Debug requests cannot enter formal result, archive, delete, or PPT actions", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-debug-block-"));
  fs.mkdirSync(path.join(project, "work_dirs", "keep"), { recursive: true });
  fs.writeFileSync(path.join(project, "work_dirs", "keep", "result.csv"), "metric,value\nAUC,0.9\n", "utf8");
  const script = [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = r'${project.replace(/\\/g, "/")}'`,
    "actions = ['archive-artifacts', 'delete-artifacts', 'parse-results', 'run-statistics', 'export-plotting-contract']",
    "out = {}",
    "for action in actions:",
    "    payload = {'debugMode': True, 'selectedArchiveKeys': ['work_dirs/keep'], 'planFile': 'experiments/plans/smoke.yaml'}",
    "    out[action] = agent.handle_action(root, action, payload, 'op-' + action, 'op-' + action)",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  const result = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  for (const action of Object.keys(payload)) {
    assert.equal(payload[action].status, "failed", `${action}: ${JSON.stringify(payload[action])}`);
    assert.match(payload[action].message, /Debug/);
  }
  assert.equal(fs.existsSync(path.join(project, "work_dirs", "keep", "result.csv")), true);
});

test("first run presents one full Plan submission action", () => {
  assert.match(panelSource, /function renderProjectFirstRunActions\(show, planFile\)/);
  assert.match(panelSource, /当前 Plan revision 尚无运行证据/);
  assert.doesNotMatch(panelSource, /建议 Debug 首跑|Debug 首跑<\/button>/);
  assert.match(panelSource, /let runMode = "formal"/);
});

test("run buttons keep clear labels and submit their explicit mode", () => {
  assert.equal(runModeActionLabel("formal", "校验并提交运行"), "校验并提交运行");
  assert.equal(runModeActionLabel("debug", "校验并提交运行"), "校验并提交运行");
  assert.equal(runModeActionLabel("formal", "重新提交"), "重新提交");
  assert.equal(runModeForButton({ debugMode: "true" }, "runPlan", "formal"), false);
  assert.equal(runModeForButton({ debugMode: "false" }, "runPlan", "debug"), false);
  assert.equal(runModeForButton({ forceFormal: "true", debugMode: "true" }, "runPlan", "debug"), false);
  assert.equal(runModeForButton({}, "validatePlan", "debug"), false);
  assert.match(panelSource, /function renderProjectFirstRunActions\(show, planFile\)/);
  assert.doesNotMatch(panelSource, /data-command="runPlan" data-debug-mode="true"/);
});

test("Debug completion skips the formal automatic result pipeline", () => {
  assert.match(schedulerSource, /if bool\(payload\.get\("debugMode"\) or event\.get\("debugMode"\)\):\s*return/);
  assert.match(agentSource, /if event_is_debug_run\(event\):\s*return \[\]/);
});

test("Formal result discovery excludes debug_runs files", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-debug-discovery-"));
  fs.mkdirSync(path.join(project, "results"), { recursive: true });
  fs.mkdirSync(path.join(project, "simple_cluster", "debug_runs", "plan", "run", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(project, "results", "formal.csv"), "metric,value\nAUC,0.9\n", "utf8");
  fs.writeFileSync(path.join(project, "simple_cluster", "debug_runs", "plan", "run", "artifacts", "results.csv"), "metric,value\nAUC,0.1\n", "utf8");
  const script = [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `print(json.dumps(agent.discover_result_files(r'${project.replace(/\\/g, "/")}')))`
  ].join("\n");
  const result = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(files.includes("results/formal.csv"), true);
  assert.equal(files.some((item) => item.includes("debug_runs")), false);
});
