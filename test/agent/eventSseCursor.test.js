const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent isolates incremental event cursors for concurrent SSE readers", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-sse-cursor-"));
  const script = path.join(project, "sse-cursor.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(project)}
journal = pathlib.Path(agent.path_for(root, "events.jsonl"))
journal.parent.mkdir(parents=True, exist_ok=True)
def event(seq):
    return {"schemaVersion": 1, "seq": seq, "type": "probe", "generatedAt": f"2026-07-26T00:00:{seq:02d}Z", "payload": {"seq": seq}}
with journal.open("w", encoding="utf-8") as handle:
    for seq in range(1, 6):
        handle.write(json.dumps(event(seq)) + "\\n")
pathlib.Path(agent.path_for(root, "seq.txt")).write_text("5", encoding="utf-8")

first_a = agent.read_events_since(root, 0, 3, "sse-a")
with journal.open("a", encoding="utf-8") as handle:
    for seq in range(6, 8):
        handle.write(json.dumps(event(seq)) + "\\n")
pathlib.Path(agent.path_for(root, "seq.txt")).write_text("7", encoding="utf-8")
second_a = agent.read_events_since(root, 5, 3, "sse-a")
first_b = agent.read_events_since(root, 3, 10, "sse-b")
cache_keys = sorted(key for key in agent.EVENT_CURSOR_CACHE if str(journal.resolve()) in key)

with journal.open("w", encoding="utf-8") as handle:
    handle.write(json.dumps(event(8)) + "\\n")
pathlib.Path(agent.path_for(root, "seq.txt")).write_text("8", encoding="utf-8")
rewritten_a = agent.read_events_since(root, 7, 10, "sse-a")

with journal.open("w", encoding="utf-8") as handle:
    handle.write(json.dumps(event(10)) + "\\n")
pathlib.Path(agent.path_for(root, "seq.txt")).write_text("10", encoding="utf-8")
gap = agent.read_events_since(root, 7, 10, "sse-a")

print(json.dumps({
    "firstA": [row["seq"] for row in first_a],
    "secondA": [row["seq"] for row in second_a],
    "firstB": [row["seq"] for row in first_b],
    "cacheKeys": cache_keys,
    "rewrittenA": [row["seq"] for row in rewritten_a],
    "gapCode": gap[0].get("payload", {}).get("code"),
    "gapSeq": gap[0].get("seq"),
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.firstA, [3, 4, 5]);
  assert.deepEqual(result.secondA, [6, 7]);
  assert.deepEqual(result.firstB, [4, 5, 6, 7]);
  assert.equal(result.cacheKeys.length, 2);
  assert.ok(result.cacheKeys.some((key) => key.endsWith("::sse-a")));
  assert.ok(result.cacheKeys.some((key) => key.endsWith("::sse-b")));
  assert.deepEqual(result.rewrittenA, [8]);
  assert.equal(result.gapCode, "journal_gap");
  assert.equal(result.gapSeq, 10);
});
