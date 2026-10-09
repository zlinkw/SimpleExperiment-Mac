const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const agentPath = path.join(root, "dist", "runtime", "cluster_agent.py");

function runPythonSnippet(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-log-size-"));
  const logPath = path.join(tmpDir, "sample.log");
  fs.writeFileSync(logPath, content, "utf8");
  const script = path.join(tmpDir, "probe.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(agentPath)})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
log = pathlib.Path(${JSON.stringify(logPath)})
size = agent._tmux_log_size(str(log))
print(json.dumps({"size": size}))
`, "utf8");
  const python = process.env.PYTHON || "python";
  const run = spawnSync(python, [script], { encoding: "utf8" });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (run.status !== 0) {
    throw new Error("python probe failed: " + (run.stderr || run.stdout));
  }
  return JSON.parse(run.stdout.trim()).size;
}

function effectiveSizeForLines(lines) {
  let total = 0;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    // mimic python filtering for cd narrow logic
    if (s.startsWith("cd ")) {
      if (s.length < 80 && (s.includes("/data") || s.includes('"') || s.includes("'")) && !s.toLowerCase().includes("experiment")) {
        continue;
      }
    }
    if (s.startsWith("[pipe-pane")) continue;
    if (s.startsWith("conda activate")) continue;
    if (s.startsWith("export ")) continue;
    if (s.includes("SIMPLE_TMUX_READY")) continue;
    total += Buffer.byteLength(s, "utf8") + 1;
  }
  return total;
}

test("cd 过滤：短 /data 与带引号的 bootstrap 行被过滤", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("python unavailable"); return; }

  // 短 cd /data
  assert.equal(runPythonSnippet("cd /data\n"), 0);
  // 带双引号
  assert.equal(runPythonSnippet('cd "/data/project"\n'), 0);
  // 带单引号
  assert.equal(runPythonSnippet("cd '/data/project'\n"), 0);
  // 短且同时含 /data 且带引号
  assert.equal(runPythonSnippet('cd "/data"\n'), 0);
  // 带空格的短路径
  assert.equal(runPythonSnippet('cd "/data/my project"\n'), 0);
});

test("cd 过滤：含 experiment 的路径即使短且带引号也保留", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("python unavailable"); return; }

  const shortExperiment = 'cd "/data/experiment_demo"\n';
  const size = runPythonSnippet(shortExperiment);
  const expected = Buffer.byteLength(shortExperiment.trim(), "utf8") + 1;
  assert.equal(size, expected, "experiment keyword should prevent filtering");

  const expNoQuote = "cd /data/experiment_run\n";
  const size2 = runPythonSnippet(expNoQuote);
  const expected2 = Buffer.byteLength(expNoQuote.trim(), "utf8") + 1;
  assert.equal(size2, expected2);

  // 大小写不敏感
  const upper = 'cd "/DATA/Experiment_X"\n';
  const size3 = runPythonSnippet(upper);
  const expected3 = Buffer.byteLength(upper.trim(), "utf8") + 1;
  assert.equal(size3, expected3);
});

test("cd 过滤：长 cd（>=80）即使含 /data 也不过滤", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("python unavailable"); return; }

  // 80 字符边界：构造 80 字符的 cd 行
  const base = 'cd /data/';
  const padding80 = base + "a".repeat(80 - base.length);
  assert.equal(padding80.length, 80);
  const size80 = runPythonSnippet(padding80 + "\n");
  const expected80 = Buffer.byteLength(padding80, "utf8") + 1;
  assert.equal(size80, expected80, "len==80 should not be filtered");

  // 79 字符应被过滤
  const padding79 = base + "a".repeat(79 - base.length);
  assert.equal(padding79.length, 79);
  assert.equal(runPythonSnippet(padding79 + "\n"), 0, "len==79 with /data should be filtered");

  // 超长含 experiment 的调度日志
  const longExperiment = "cd /data/projects/experiment_run_2024/batch_001 && python train.py --epochs 100 --batch-size 32\n";
  assert.ok(longExperiment.trim().length >= 80);
  const sizeLong = runPythonSnippet(longExperiment);
  const expectedLong = Buffer.byteLength(longExperiment.trim(), "utf8") + 1;
  assert.equal(sizeLong, expectedLong);
});

test("cd 过滤：无 /data 且无引号的短 cd 保留", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("python unavailable"); return; }

  const cases = ["cd /tmp\n", "cd /home/user\n", "cd .\n", "cd ..\n"];
  for (const c of cases) {
    const size = runPythonSnippet(c);
    const expected = Buffer.byteLength(c.trim(), "utf8") + 1;
    assert.equal(size, expected, `should retain ${JSON.stringify(c)}`);
  }
});

test("混合日志：仅有意义行计入有效大小", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("python unavailable"); return; }

  const content = [
    "", // 空行
    "cd /data", // 过滤
    'cd "/data/project"', // 过滤
    "conda activate torch2", // 过滤
    "export PATH=/usr/bin", // 过滤
    "[pipe-pane] something", // 过滤
    "SIMPLE_TMUX_READY 1", // 过滤
    'cd "/data/experiment_demo"', // 保留（experiment）
    "cd /tmp", // 保留（无 /data/引号）
    "2026-08-30 INFO scheduler started epoch 1", // 保留
    "epoch 1/100 loss=0.23", // 保留
    "   ", // 空白
  ].join("\n") + "\n";

  const size = runPythonSnippet(content);
  const expectedLines = [
    'cd "/data/experiment_demo"',
    "cd /tmp",
    "2026-08-30 INFO scheduler started epoch 1",
    "epoch 1/100 loss=0.23",
  ];
  const expected = effectiveSizeForLines(expectedLines);
  // also via python direct should match our JS helper
  assert.equal(size, expected);

  // 额外验证：纯 bootstrap 混合应大大小于原始文件大小
  const rawSize = Buffer.byteLength(content, "utf8");
  assert.ok(size < rawSize);
  assert.ok(size > 0);
});
