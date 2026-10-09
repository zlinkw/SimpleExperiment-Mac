const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("audit tail reads a bounded window instead of the whole journal", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-audit-tail-"));
  const logsDir = path.join(root, "simple_cluster", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const auditPath = path.join(logsDir, "operation_audit.jsonl");
  const totalLines = 4000;
  const filler = "x".repeat(600);
  fs.writeFileSync(
    auditPath,
    Array.from({ length: totalLines }, (unused, index) => JSON.stringify({ seq: index, note: filler })).join("\n") + "\n",
    "utf8"
  );
  const auditSize = fs.statSync(auditPath).size;

  const script = String.raw`
import importlib.util, json, os

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(root.replace(/\\/g, "/"))}
audit = os.path.join(root, "simple_cluster", "logs", "operation_audit.jsonl")

reads = {"bytes": 0}
real_open = open
class CountingFile:
    def __init__(self, handle):
        self._handle = handle
    def read(self, *args):
        data = self._handle.read(*args)
        reads["bytes"] += len(data)
        return data
    def __getattr__(self, name):
        return getattr(self._handle, name)
    def __enter__(self):
        self._handle.__enter__()
        return self
    def __exit__(self, *args):
        return self._handle.__exit__(*args)

def counting_open(path, *args, **kwargs):
    handle = real_open(path, *args, **kwargs)
    if os.path.abspath(path) == os.path.abspath(audit):
        return CountingFile(handle)
    return handle

agent.open = counting_open

tail = agent.read_audit_tail(root)
lines = tail.splitlines()
bundle_tail = agent.read_audit_tail(root, 200)

print(json.dumps({
    "lineCount": len(lines),
    "bytesRead": reads["bytes"],
    "defaultBudget": agent.audit_tail_byte_budget(100),
    "bundleBudget": agent.audit_tail_byte_budget(200),
    "maxBudget": agent.AUDIT_TAIL_MAX_BYTES,
    "bundleLineCount": len(bundle_tail.splitlines()),
    "lastSeq": json.loads(lines[-1])["seq"],
    "firstSeq": json.loads(lines[0])["seq"],
    "missingRoot": agent.read_audit_tail(os.path.join(root, "missing")),
}))
`;

  try {
    const run = spawnSync("python", ["-c", script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.lineCount, 100);
    assert.equal(result.bundleLineCount, 200);
    assert.equal(result.lastSeq, totalLines - 1);
    assert.equal(result.firstSeq, totalLines - 100);
    assert.equal(result.missingRoot, "");
    assert.ok(result.bytesRead < auditSize, `read ${result.bytesRead} of ${auditSize} bytes`);
    assert.ok(result.bytesRead <= result.defaultBudget + result.bundleBudget, `read ${result.bytesRead} bytes`);
    assert.ok(result.bundleBudget <= result.maxBudget, "bundle budget must stay under the cap");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit tail falls back to the tmp journal and stays byte bounded", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /AUDIT_TAIL_MAX_BYTES = 1024 \* 1024/);
  assert.match(source, /def audit_tail_byte_budget\(line_limit\)/);
  assert.doesNotMatch(source, /f\.readlines\(\)\[-lines:\]/);
  assert.match(source, /os\.path\.join\(root, "simple_cluster", "tmp", "operation_audit\.jsonl"\)/);
});
