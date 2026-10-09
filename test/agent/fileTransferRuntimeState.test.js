const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const { CLUSTER_AGENT_RUNTIME } = require("../../dist/clusterAgentRuntime.js");

test("agent file transfer status is project-scoped and sanitized", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  assert.match(CLUSTER_AGENT_RUNTIME, /def transfer_status_path\(root, transfer_id\):/);
  assert.match(CLUSTER_AGENT_RUNTIME, /safe_project_path\(root, "simple_cluster\/file_transfers\/" \+ safe_record_name\(transfer_id\)\)/);
  assert.match(CLUSTER_AGENT_RUNTIME, /return self\.send_json\(read_transfer_status\(root, transfer_id\)\)/);
  assert.match(CLUSTER_AGENT_RUNTIME, /write_transfer_status\(root, item\)/);
  assert.doesNotMatch(CLUSTER_AGENT_RUNTIME, /"schemaVersion": SCHEMA_VERSION, \*\*UPLOADS\.get\(transfer_id/);

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-agent-transfer-ledger-"));
  const script = path.join(project, "transfer-ledger.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib, os
root = pathlib.Path(${JSON.stringify(project)})
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
item = {"schemaVersion": 1, "transferId": "tx-1", "status": "completed", "direction": "upload", "remotePath": "experiments/results/a.csv", "transferredBytes": 3, "totalBytes": 3, "size": 3, "sha256": "abc", "tmp": "C:/secret/tmp.bin", "targetAtInit": {"sha256": "old"}, "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:00:01Z"}
public = agent.write_transfer_status(str(root), item)
agent.UPLOADS.clear()
restored = agent.read_transfer_status(str(root), "tx-1")
files = list((root / "simple_cluster" / "file_transfers").glob("*.json"))
ledger = json.loads(files[0].read_text(encoding="utf-8"))
print(json.dumps({"public": public, "restored": restored, "ledger": ledger, "fileCount": len(files)}, ensure_ascii=False))
`, "utf8");
  const run = spawnSync(python, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.fileCount, 1);
  assert.equal(result.restored.status, "completed");
  assert.equal(result.ledger.remotePath, "experiments/results/a.csv");
  assert.equal(Object.prototype.hasOwnProperty.call(result.ledger, "tmp"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.ledger, "targetAtInit"), false);
});