const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

// Widening the read-modify-write window with a sleep (not a barrier) keeps the test valid for a
// serialised implementation: a barrier would deadlock precisely because the lock works.
const CONCURRENCY_SCRIPT = (agentPath, root) => String.raw`
import importlib.util, json, threading, time

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(root)}
agent.maybe_auto_run_completion_pipeline = lambda *args, **kwargs: None
agent.prune_agent_state = lambda *args, **kwargs: None

real_read_seq = agent.read_seq
def slow_read_seq(project_root):
    value = real_read_seq(project_root)
    time.sleep(0.005)
    return value
agent.read_seq = slow_read_seq

THREADS = 8
PER_THREAD = 5
errors = []
def worker(index):
    try:
        for step in range(PER_THREAD):
            agent.append_event(root, {"type": "test_event", "payload": {"thread": index, "step": step}})
    except Exception as exc:
        errors.append(repr(exc))

threads = [threading.Thread(target=worker, args=(index,)) for index in range(THREADS)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(60)

journal = agent.path_for(root, "events.jsonl")
lines = [line for line in open(journal, "r", encoding="utf-8").read().split("\n") if line.strip()]
parsed = [json.loads(line) for line in lines]
seqs = [item["seq"] for item in parsed]

print(json.dumps({
    "errors": errors,
    "alive": [thread.is_alive() for thread in threads].count(True),
    "lineCount": len(lines),
    "expected": THREADS * PER_THREAD,
    "uniqueSeqs": len(set(seqs)),
    "maxSeq": max(seqs),
    "finalSeq": real_read_seq(root),
    "payloadsIntact": len([item for item in parsed if isinstance(item.get("payload"), dict) and "thread" in item["payload"]]),
    "threadsSeen": len({item["payload"]["thread"] for item in parsed if isinstance(item.get("payload"), dict) and "thread" in item["payload"]}),
}))
`;

test("concurrent event appends keep sequence numbers unique and lines intact", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-event-append-"));
  try {
    const run = spawnSync("python", ["-c", CONCURRENCY_SCRIPT(agentPath, root.replace(/\\/g, "/"))], { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.deepEqual(result.errors, []);
    assert.equal(result.alive, 0, "no appender may be left blocked");
    assert.equal(result.lineCount, result.expected, "every append must produce exactly one journal line");
    assert.equal(result.uniqueSeqs, result.expected, "sequence numbers must not repeat");
    assert.equal(result.maxSeq, result.expected);
    assert.equal(result.finalSeq, result.expected);
    assert.equal(result.payloadsIntact, result.expected, "journal lines must not interleave");
    assert.equal(result.threadsSeen, 8, "every appender must be represented");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent atomic writes to one target do not clobber each other", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-atomic-write-"));
  const script = String.raw`
import importlib.util, json, os, threading, time

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

target = os.path.join(${JSON.stringify(root.replace(/\\/g, "/"))}, "state", "shared.json")
real_dump = json.dump
def slow_dump(payload, handle, **kwargs):
    real_dump(payload, handle, **kwargs)
    time.sleep(0.005)
agent.json.dump = slow_dump

errors = []
def writer(index):
    try:
        for step in range(4):
            agent.atomic_write(target, {"writer": index, "step": step})
    except Exception as exc:
        errors.append(repr(exc))

threads = [threading.Thread(target=writer, args=(index,)) for index in range(8)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(60)

directory = os.path.dirname(target)
leftovers = [name for name in os.listdir(directory) if ".tmp." in name]
final = json.load(open(target, "r", encoding="utf-8"))

print(json.dumps({
    "errors": errors,
    "leftovers": leftovers,
    "finalHasWriter": isinstance(final, dict) and "writer" in final,
}))
`;
  try {
    const run = spawnSync("python", ["-c", script], { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.deepEqual(result.errors, [], "concurrent writers must not collide on the temp path");
    assert.deepEqual(result.leftovers, [], "no temp file may survive a completed write");
    assert.equal(result.finalHasWriter, true, "the target must hold one writer's complete payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("event and worker command appends share one reentrant critical section", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /EVENT_APPEND_LOCK = threading\.RLock\(\)/);
  assert.match(source, /with EVENT_APPEND_LOCK:\r?\n {8}seq = read_seq\(root\) \+ 1/);
  assert.match(source, /write_seq\(root, seq\)\r?\n {8}compact_journal\(root\)/);
  assert.match(source, /with EVENT_APPEND_LOCK:\r?\n {8}with open\(worker_command_path\(root, worker_id\)/);
  // The completion pipeline can re-enter append_event, so it must stay outside the lock.
  assert.match(source, /\r?\n {4}prune_agent_state\(root\)\r?\n {4}maybe_auto_run_completion_pipeline\(root, original_event\)/);
  assert.match(source, /temporary = path \+ "\.writing"/);
});
