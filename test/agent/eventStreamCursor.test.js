const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent CLI event stream resumes reads and resets after journal replacement or truncation", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-stream-cursor-"));
  const script = path.join(project, "stream-cursor.py");
  fs.writeFileSync(script, `
import importlib.util, inspect, json, os, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(project)}
journal = pathlib.Path(agent.path_for(root, "events.jsonl"))
journal.parent.mkdir(parents=True, exist_ok=True)
def event(seq):
    return {"schemaVersion": 1, "seq": seq, "type": "probe", "payload": {"seq": seq}}
def write(target, seqs):
    with target.open("w", encoding="utf-8") as handle:
        for seq in seqs:
            handle.write(json.dumps(event(seq)) + "\\n")

write(journal, [1, 2, 3])
first = agent.read_stream_event_batch(root, 0)
with journal.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(event(4)) + "\\n")
second = agent.read_stream_event_batch(root, first[3], first[2], first[4], first[5])

replacement = journal.with_suffix(".replacement")
write(replacement, [5, 6])
os.replace(replacement, journal)
replaced = agent.read_stream_event_batch(root, second[3], second[2], second[4], second[5])

write(journal, [8])
truncated = agent.read_stream_event_batch(root, replaced[3], replaced[2], replaced[4], replaced[5])

print(json.dumps({
    "firstSeqs": [row["seq"] for row in first[0]],
    "secondSeqs": [row["seq"] for row in second[0]],
    "replacedSeqs": [row["seq"] for row in replaced[0]],
    "truncatedSeqs": [row["seq"] for row in truncated[0]],
    "truncatedGap": (truncated[1] or {}).get("payload", {}).get("code"),
    "positionAdvanced": second[2] > first[2],
    "replacementIdentityChanged": replaced[4] != second[4],
    "usesReadlines": "readlines(" in inspect.getsource(agent.read_stream_event_batch),
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.firstSeqs, [1, 2, 3]);
  assert.deepEqual(result.secondSeqs, [4]);
  assert.deepEqual(result.replacedSeqs, [5, 6]);
  assert.deepEqual(result.truncatedSeqs, [8]);
  assert.equal(result.truncatedGap, "journal_gap");
  assert.equal(result.positionAdvanced, true);
  assert.equal(result.replacementIdentityChanged, true);
  assert.equal(result.usesReadlines, false);
});
