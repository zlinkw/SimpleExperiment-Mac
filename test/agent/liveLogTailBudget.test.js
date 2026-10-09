const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent live output reads a bounded tail while retaining real file offset", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-live-tail-"));
  const script = path.join(project, "live-tail.py");
  fs.writeFileSync(script, `
import importlib.util, json, os, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = pathlib.Path(${JSON.stringify(project)})
short = root / "short.log"
short.write_text("一\\n二\\n三\\n", encoding="utf-8")
short_text, short_offset = agent.read_live_log_tail(short, 2)

large = root / "large.log"
prefix = "x" * (agent.LIVE_LOG_TAIL_MAX_BYTES + 4096)
large.write_text(prefix + "\\nkeep-1\\nkeep-2\\nkeep-3\\n", encoding="utf-8")
large_text, large_offset = agent.read_live_log_tail(large, 2)
state = {"running_experiments": [{"runKey": "run-a", "log_path": str(large)}]}
events = agent.collect_live_output([state], 2)

print(json.dumps({
    "shortText": short_text,
    "shortOffset": short_offset,
    "shortSize": short.stat().st_size,
    "largeText": large_text,
    "largeOffset": large_offset,
    "largeSize": large.stat().st_size,
    "eventText": events[0]["text"],
    "eventOffset": events[0]["offset"],
    "budget": agent.LIVE_LOG_TAIL_MAX_BYTES,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.shortText, "二\n三\n");
  assert.equal(result.shortOffset, result.shortSize);
  assert.equal(result.largeText, "keep-2\nkeep-3\n");
  assert.equal(result.largeOffset, result.largeSize);
  assert.equal(result.eventText, result.largeText);
  assert.equal(result.eventOffset, result.largeSize);
  assert.equal(result.budget, 256 * 1024);
});
