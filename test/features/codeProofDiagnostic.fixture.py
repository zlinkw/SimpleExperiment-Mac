"""Read-only original content proof; production queue/proof bytes must not change."""
import copy
import hashlib
import json
import os
import pathlib
import sys
import tempfile

repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(str(repo / "dist/runtime/cluster_agent.py"),
    ["verify_code_sync_proof_record", "_code_sync_stat_record"])
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-proof-readonly-"))
source = root / "wrapper.py"
source.write_bytes(b"original wrapper bytes")
expected = {"size": source.stat().st_size, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
manifest = {"wrapper.py": expected}
fingerprint = agent.durable_code_manifest_digest(manifest)
generation = agent.code_sync_proof_runtime_generation()
scope = hashlib.sha256(b"fixture scope").hexdigest()
proof_id = agent.code_sync_proof_id("project", fingerprint, fingerprint, scope, generation)
row = {"projectId": "project", "codeFingerprint": fingerprint, "manifestDigest": fingerprint, "codeSyncProofId": proof_id}
proof = {**row, "proofId": proof_id, "runtimeGeneration": generation, "scopeSignature": scope,
         "fileCount": 1, "files": [agent._code_sync_stat_record(str(root), "wrapper.py", expected)]}
original = copy.deepcopy(proof)
stat = source.stat()
os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
try:
    agent.verify_code_sync_proof_record(str(root), proof, row)
    raise AssertionError("execution accepted a stale stat proof")
except ValueError as exc:
    assert "stat changed" in str(exc)
assert agent.verify_code_sync_proof_record(str(root), proof, row, verify_content=True) == original
assert proof == original and source.read_bytes() == b"original wrapper bytes"
# Historical proofs lacking SHA can use only a manifest bound to the original fingerprint.
legacy = copy.deepcopy(proof)
legacy["files"][0].pop("sha256")
try:
    agent.verify_code_sync_proof_record(str(root), legacy, row, verify_content=True)
    raise AssertionError("missing original hash was fabricated")
except ValueError as exc:
    assert "ORIGINAL_HASH_UNAVAILABLE" in str(exc)
agent.verify_code_sync_proof_record(str(root), legacy, {**row, "codeManifest": manifest}, verify_content=True)
# Same size and original timestamp cannot conceal different content in a diagnostic.
source.write_bytes(b"changed! wrapper bytes")
os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
try:
    agent.verify_code_sync_proof_record(str(root), proof, row, verify_content=True)
    raise AssertionError("changed bytes passed the original SHA")
except ValueError as exc:
    assert "code changed" in str(exc)
assert proof == original
print(json.dumps({"readonly": True, "metadataOnlyAcceptedByDiagnostic": True, "executionStillRejects": True, "contentChangedRejected": True}))
