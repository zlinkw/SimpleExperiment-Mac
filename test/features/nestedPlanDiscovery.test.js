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
    "sys.path.insert(0, r'" + path.dirname(runtime).replace(/\\/g, "/") + "')",
    "import cluster_agent as agent",
    "root = r'" + root.replace(/\\/g, "/") + "'",
    "plans = agent.discover_plan_files(root, 'experiments/plans')",
    "print(json.dumps(plans))",
  ].join("; ");
  const proc = spawnSync("python", ["-c", py], { encoding: "utf8" });
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
