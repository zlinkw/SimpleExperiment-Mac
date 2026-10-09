const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/clusterAgentRuntime.ts");

function pythonDefinition(name) {
  const start = source.search(new RegExp(`^def ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing production definition: ${name}`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\\s*=)/m);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

test("Worker code-sync proof is durable, stat-checked, and legacy content hashing is cached", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-sync-proof-"));
  const scriptPath = path.join(os.tmpdir(), `code-sync-proof-${process.pid}-${Date.now()}.py`);
  const definitions = [
    "durable_code_manifest_digest", "code_sync_proof_runtime_generation", "code_sync_proof_id",
    "code_sync_proof_document", "_code_sync_stat_record", "verify_code_sync_proof_record",
    "_store_code_sync_proof", "register_code_sync_proof", "_legacy_durable_code_sync_proof",
    "resolve_durable_code_sync_proof",
    "renew_code_sync_proof_runtime",
  ].map(pythonDefinition);
  const script = String.raw`
import builtins, hashlib, json, os, re, threading, time
ROOT = ${JSON.stringify(root.replace(/\\/g, "/"))}
AGENT_VERSION = "agent-test"
RUNTIME_VERSION = "runtime-test"
PLUGIN_VERSION = "plugin-test"
CODE_SYNC_PROOF_LOCK = threading.RLock()
def path_for(root, name):
    folder = os.path.join(root, ".agent")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, name)
def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle: return json.load(handle)
    except Exception: return fallback
def atomic_write(path, payload, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle: json.dump(payload, handle, ensure_ascii=False)
    os.replace(temp, path)
def now_iso(): return "2026-10-01T00:00:00Z"
def signal_durable_plan_queue_processor(root, worker_id): pass
${definitions.join("\n\n")}

source_path = os.path.join(ROOT, "src", "train.py")
os.makedirs(os.path.dirname(source_path), exist_ok=True)
content = b"verified-source"
with open(source_path, "wb") as handle: handle.write(content)
manifest = {"src/train.py": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}
fingerprint = durable_code_manifest_digest(manifest)
scope = hashlib.sha256(b"scope").hexdigest()
request = {"projectId":"project-a", "workerId":"worker-a", "codeFingerprint":fingerprint,
    "manifestDigest":fingerprint, "scopeSignature":scope, "codeManifest":manifest}
bytes_read = 0
real_open = builtins.open
class CountedReader:
    def __init__(self, handle): self.handle = handle
    def __enter__(self): return self
    def __exit__(self, *args): return self.handle.__exit__(*args)
    def read(self, count=-1):
        global bytes_read
        data = self.handle.read(count)
        bytes_read += len(data)
        return data
def counted_open(file, mode="r", *args, **kwargs):
    handle = real_open(file, mode, *args, **kwargs)
    return CountedReader(handle) if mode == "rb" and os.path.realpath(file) == os.path.realpath(source_path) else handle
open = counted_open
registered = register_code_sync_proof(ROOT, request, "worker-a")
assert registered["ok"] is True and registered["fileCount"] == 1 and bytes_read == 0
compact = {"projectId":"project-a", "codeFingerprint":fingerprint, "manifestDigest":fingerprint,
    "codeSyncProofId":registered["proofId"]}
for _ in range(6): resolve_durable_code_sync_proof(ROOT, compact)
assert bytes_read == 0, "compact dispatch stat-checks without reading file contents"
try:
    resolve_durable_code_sync_proof(ROOT, {"projectId":"project-a", "codeFingerprint":fingerprint})
    raise AssertionError("missing proof must fail closed")
except ValueError as error:
    assert "proof missing" in str(error)
stat = os.stat(source_path)
os.utime(source_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
try:
    resolve_durable_code_sync_proof(ROOT, compact)
    raise AssertionError("changed stat must fail closed")
except ValueError as error:
    assert "stat changed" in str(error)
with real_open(source_path, "wb") as handle: handle.write(content)
refreshed = register_code_sync_proof(ROOT, request, "worker-a")
assert refreshed["ok"] is True and refreshed["reused"] is False and bytes_read == 0
compact["codeSyncProofId"] = refreshed["proofId"]
resolve_durable_code_sync_proof(ROOT, compact)

# Pre-capability callers may still submit a manifest. Its full content hash is cached once per proof.
legacy = {"projectId":"project-a", "codeFingerprint":fingerprint, "codeManifest":manifest}
for _ in range(6): resolve_durable_code_sync_proof(ROOT, legacy)
assert bytes_read == len(content), "six jobs with one legacy fingerprint must hash file contents once"

# A queued job survives an Agent upgrade with the same source and full proof identity.
previous_id = compact["codeSyncProofId"]
previous_generation = code_sync_proof_runtime_generation()
AGENT_VERSION = "agent-upgraded"
old_proof = code_sync_proof_document(ROOT)["proofs"][previous_id]
try:
    verify_code_sync_proof_record(ROOT, old_proof, compact)
    raise AssertionError("direct stale proof verification must still fail closed")
except ValueError as error:
    assert "stale runtime generation" in str(error)
for bad_proof in [dict(old_proof, fileCount=999), dict(old_proof, schemaVersion=99),
                  dict(old_proof, proofId="0" * 64)]:
    try:
        renew_code_sync_proof_runtime(ROOT, bad_proof, compact)
        raise AssertionError("runtime renewal must not accept a malformed proof")
    except ValueError: pass
renewed = resolve_durable_code_sync_proof(ROOT, compact)
assert renewed["proofId"] != previous_id
assert renewed["runtimeGeneration"] == code_sync_proof_runtime_generation()
assert renewed["previousProofId"] == previous_id
assert renewed["runtimeRenewedFrom"] == previous_generation
assert previous_id in code_sync_proof_document(ROOT)["proofs"], "renewal preserves original proof provenance"
for _ in range(6):
    assert resolve_durable_code_sync_proof(ROOT, compact)["proofId"] == renewed["proofId"]
assert bytes_read == len(content), "unchanged source keeps the existing stat-bound cache"
for field, value in [("projectId", "other-project"), ("codeFingerprint", "0" * 64), ("manifestDigest", "0" * 64)]:
    bad = dict(compact, **{field: value})
    try:
        resolve_durable_code_sync_proof(ROOT, bad)
        raise AssertionError("runtime renewal must not accept another identity")
    except ValueError: pass
stat = os.stat(source_path)
os.utime(source_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
AGENT_VERSION = "agent-upgraded-again"
try:
    resolve_durable_code_sync_proof(ROOT, compact)
    raise AssertionError("runtime renewal must not accept changed source stat")
except ValueError as error:
    assert "stat changed" in str(error)
print(json.dumps({"compactStatOnly":True,"missingAndStaleFailClosed":True,"legacyHashCount":1}))
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    const run = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { compactStatOnly: true, missingAndStaleFailClosed: true, legacyHashCount: 1 });
  } finally {
    fs.unlinkSync(scriptPath);
  }
});
