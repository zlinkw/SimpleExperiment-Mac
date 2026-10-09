const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent Worker uplink resumes event reads from a bounded file cursor", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-event-cursor-"));
  const script = path.join(project, "event-cursor.py");
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
    return {"schemaVersion": 1, "seq": seq, "type": "probe", "payload": {"seq": seq}}
with journal.open("w", encoding="utf-8") as handle:
    for seq in range(1, 151):
        if seq == 17:
            handle.write("{broken\\n")
        handle.write(json.dumps(event(seq)) + "\\n")

first = agent.read_events_after_seq(root, 0, 100)
first_cursor = dict(agent.EVENT_CURSOR_CACHE[str(journal.resolve())])
with journal.open("a", encoding="utf-8") as handle:
    for seq in range(151, 154):
        handle.write(json.dumps(event(seq)) + "\\n")
second = agent.read_events_after_seq(root, 150, 100)
second_cursor = dict(agent.EVENT_CURSOR_CACHE[str(journal.resolve())])
retry = agent.read_events_after_seq(root, 148, 10)

with journal.open("w", encoding="utf-8") as handle:
    for seq in range(154, 156):
        handle.write(json.dumps(event(seq)) + "\\n")
rewritten = agent.read_events_after_seq(root, 153, 10)

agent.EVENT_CURSOR_CACHE.clear()
cache_now = 5000
for index in range(agent.MAX_EVENT_CURSOR_RECORDS + 12):
    agent.EVENT_CURSOR_CACHE[f"path-{index}"] = {"lastUsedAt": cache_now - index}
agent.EVENT_CURSOR_CACHE["active-old"] = {"lastUsedAt": cache_now - agent.EVENT_CURSOR_TTL_SECONDS - 1}
agent.prune_event_cursor_cache(cache_now, "active-old")

print(json.dumps({
    "firstSeqs": [item["seq"] for item in first],
    "secondSeqs": [item["seq"] for item in second],
    "retrySeqs": [item["seq"] for item in retry],
    "rewrittenSeqs": [item["seq"] for item in rewritten],
    "cursorAdvanced": second_cursor["offset"] > first_cursor["offset"],
    "cursorCount": len(agent.EVENT_CURSOR_CACHE),
    "cursorNewest": "path-0" in agent.EVENT_CURSOR_CACHE,
    "cursorOldInactive": f"path-{agent.MAX_EVENT_CURSOR_RECORDS + 11}" in agent.EVENT_CURSOR_CACHE,
    "cursorActive": "active-old" in agent.EVENT_CURSOR_CACHE,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.firstSeqs.length, 100);
  assert.deepEqual(result.firstSeqs.slice(0, 3), [51, 52, 53]);
  assert.deepEqual(result.firstSeqs.slice(-3), [148, 149, 150]);
  assert.deepEqual(result.secondSeqs, [151, 152, 153]);
  assert.deepEqual(result.retrySeqs, [149, 150, 151, 152, 153]);
  assert.deepEqual(result.rewrittenSeqs, [154, 155]);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(result.cursorCount, 64);
  assert.equal(result.cursorNewest, true);
  assert.equal(result.cursorOldInactive, false);
  assert.equal(result.cursorActive, true);
});
