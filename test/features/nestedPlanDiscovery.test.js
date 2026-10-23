const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

test("agent discover_plan_files walks nested plan subfolders", () => {
  for (const rel of [
    "src/clusterAgentRuntime.legacy.ts",
    "dist/clusterAgentRuntime.legacy.js",
    "dist/runtime/cluster_agent.py",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
    assert.match(source, /def discover_plan_files\(root, plan_dir=None, limit=500\):/);
    assert.match(source, /for dirpath, dirnames, filenames in os\.walk\(base_path\):/);
    assert.match(source, /discover_plan_files\(root, "experiments\/plans"/);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-nested-plans-"));
  write(path.join(root, "experiments", "plans", "top.yaml"), "suite: top\nbase_config: configs/base.yaml\n");
  write(path.join(root, "experiments", "plans", "suite_a", "nested.yaml"), "suite: nested\nbase_config: configs/base.yaml\n");
  write(path.join(root, "experiments", "plans", "suite_a", "deep", "leaf.yaml"), "suite: leaf\nbase_config: configs/base.yaml\n");
  write(path.join(root, "experiments", "plans", "_archived", "old.yaml"), "suite: old\nbase_config: configs/base.yaml\n");

  const runtime = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const py = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "../_helpers"))})`,
    "from extractRuntimeFunctions import extract_runtime_functions",
    `agent = extract_runtime_functions(${JSON.stringify(runtime)}, ["discover_plan_files"])`,
    "root = r'" + root.replace(/\\/g, "/") + "'",
    "plans = agent.discover_plan_files(root, 'experiments/plans')",
    "print(json.dumps(plans))",
  ].join("; ");
  const proc = spawnSync("python", ["-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, py, "utf8"); console.log("kept Python fixture at " + d); return file; })()], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const plans = JSON.parse((proc.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop());
  assert.ok(plans.includes("experiments/plans/top.yaml"), JSON.stringify(plans));
  assert.ok(plans.includes("experiments/plans/suite_a/nested.yaml"), JSON.stringify(plans));
  assert.ok(plans.includes("experiments/plans/suite_a/deep/leaf.yaml"), JSON.stringify(plans));
  assert.ok(!plans.some((item) => item.includes("/_archived/")), JSON.stringify(plans));
});

test("extension archive keeps nested plan subfolder under _archived", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /bundleParent = path\.join\(planRoot, "_archived", path\.dirname\(relativeFromPlanDir\)\)/);
  assert.match(source, /walkYaml\(dir\)/);
  assert.match(source, /isArchivedPlanFile\(root, planDir, fullPath\)/);
  // 7c23e89 基线面板不内联 nestedFolder 文案；嵌套发现与归档由 extension/agent 承担。
});
