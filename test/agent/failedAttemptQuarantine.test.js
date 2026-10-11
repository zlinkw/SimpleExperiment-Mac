const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");
const source = readSource("src/clusterAgentRuntime.ts");
function definition(name) {
  const start = source.search(new RegExp(`^def ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const tail = source.slice(start), next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\s*=)/m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
test("failed attempt move verifies exact identity, content, parent, ownership and restart idempotency", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simpleex-failed-attempt-"));
  const script = path.join(root, "fixture.py");
  const functions = ["durable_plan_value", "durable_plan_identity", "inspect_plan_output_retirement",
    "failed_attempt_content_digest", "move_failed_attempt_exact", "quarantine_failed_worker_attempt"].map(definition).join("\n");
  fs.writeFileSync(script, `import os, re, json, hashlib, subprocess, threading, types, time, stat
ROOT = ${JSON.stringify(root)}
# NTFS directory-entry ctime can lag the handle's ctime after creation. Model stable POSIX ctime in this fixture;
# actual inode, mode, mtime, byte length and SHA256 remain checked by the unmodified production functions.
if os.name == "nt":
    original_lstat, original_fstat = os.lstat, os.fstat
    def stable_ctime(info):
        values = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
        values["st_ctime_ns"] = 0
        return types.SimpleNamespace(**values)
    os.lstat = lambda *args, **kw: stable_ctime(original_lstat(*args, **kw))
    os.fstat = lambda *args, **kw: stable_ctime(original_fstat(*args, **kw))
DURABLE_PLAN_IDENTITY_FIELDS = ("projectId", "workflowId", "planFile", "planRevision", "codeFingerprint", "experimentIndex", "case", "seed", "attempt", "outputDir", "runKey", "commandId", "workerId")
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
FAILED_ATTEMPT_MOVE_LOCK = threading.RLock()
INACTIVITY_ACTION_CONTEXT = threading.local()
tasks = []
closed = []
tombstones = []
def api_worker_tasks(root): return {"tasks": tasks}
def _is_pid_alive(pid): return pid == 12345
def close_worker_task_pane(root, task):
    closed.append(task["commandId"])
    return {"paneClosed": task.get("paneFailure") is not True}
def write_worker_recall_tombstone(root, receipt): tombstones.append(receipt)
def now_iso(): return "2026-10-10T00:00:00Z"
def progress_action(*args, **kwargs): pass
def path_for(root, name): return os.path.join(root, name)
def read_json(file, default):
    if not os.path.exists(file): return default
    with open(file, encoding="utf-8") as stream: return json.load(stream)
def atomic_write(file, value):
    with open(file, "w", encoding="utf-8") as stream: json.dump(value, stream, ensure_ascii=False)
${functions}

# Windows fixtures emulate only the bounded POSIX move. All preflight, hashes and journal code above are production functions.
move_calls = []
def run_move(args, **kwargs):
    assert args[:2] == ["sh", "-c"]
    assert 'cd -- "$1" || exit 41' in args[2] and 'pwd -P' in args[2]
    assert 'mv -n -T -- "$2" "$3"' in args[2]
    parent, short, destination = args[4:7]
    assert args[7] == os.path.dirname(destination)
    info = os.lstat(os.path.join(parent, short[2:]))
    assert args[8] == str(info.st_dev) + ":" + str(info.st_ino)
    assert short.startswith("./") and "/" not in short[2:] and "\\\\" not in short
    assert os.path.realpath(parent) == parent and os.path.commonpath((ROOT, parent)) == ROOT
    assert not os.path.lexists(destination)
    move_calls.append((parent, short, destination))
    os.rename(os.path.join(parent, short[2:]), destination)
    return types.SimpleNamespace(returncode=0, stderr="", stdout="")
subprocess.run = run_move
def setup(name, **patch):
    root = os.path.join(ROOT, name)
    os.mkdir(root)
    output = "work_dirs/cpsc/0/attempts/attempt-old"
    source = os.path.join(root, *output.split("/"))
    os.makedirs(source)
    with open(os.path.join(source, "checkpoint.bin"), "wb") as stream:
        stream.write(b"not expendable without verification")
        stream.flush()
        os.fsync(stream.fileno())
    sibling = os.path.join(root, "work_dirs/cpsc/0/attempts/other-version")
    os.mkdir(sibling)
    with open(os.path.join(sibling, "keep.bin"), "wb") as stream:
        stream.write(b"keep-other-version")
        stream.flush()
        os.fsync(stream.fileno())
    identity = dict(projectId="project", workflowId="workflow", planFile="plans/cpsc.yaml", planRevision="revision", codeFingerprint="code", experimentIndex=0,
        case="cpsc", seed=42, attempt=1, outputDir=output, runKey="command-old", commandId="command-old", workerId="worker-old", gpuId="1")
    tasks[:] = [{**identity, "status": "failed", **patch}]
    payload = {**identity, "targetCommandId": "command-old", "recoveryId": "recover-123456", "remoteRoot": root,
        "approvedAbsolutePath": source, "approvedDestination": os.path.join(root, "clean_dir", *output.split("/")), "confirm": True, "pathConfirmed": True}
    return root, source, sibling, payload
def reject(root, payload, message=None):
    try: quarantine_failed_worker_attempt(root, payload)
    except ValueError as exc:
        if message: assert message in str(exc), str(exc)
    else: raise AssertionError("unsafe relocation was accepted")

root, source, sibling, payload = setup("valid")
report = quarantine_failed_worker_attempt(root, payload)
assert report["quarantined"] and not os.path.exists(source)
assert os.path.isfile(os.path.join(sibling, "keep.bin"))
destination = payload["approvedDestination"]
assert open(os.path.join(destination, "checkpoint.bin"), "rb").read() == b"not expendable without verification"
manifest = os.path.join(root, "clean_dir", "MANIFEST.md")
before = open(manifest, encoding="utf-8").read()
assert "checkpoint.bin" in before and report["contentSha256"] in before
repeated = quarantine_failed_worker_attempt(root, payload)
assert repeated["contentSha256"] == report["contentSha256"]
assert open(manifest, encoding="utf-8").read() == before
assert len(move_calls) == 1
# A receipt lost after the rename is recovered from the prepared journal, never re-moved.
journal_file = path_for(root, "failed_attempt_moves.json")
journal = read_json(journal_file, {})
journal["entries"][payload["recoveryId"]]["status"] = "prepared"
atomic_write(journal_file, journal)
assert quarantine_failed_worker_attempt(root, payload)["quarantined"]
assert len(move_calls) == 1
with open(os.path.join(destination, "checkpoint.bin"), "ab") as stream: stream.write(b"externally changed")
reject(root, payload, "SHA256 inventory mismatch")
assert len(move_calls) == 1

for name, patch, reason in [("completed", {"status": "completed"}, "completed"), ("active", {"status": "running"}, "active"),
    ("pid", {"pid": 12345}, "live process"), ("pane", {"paneFailure": True}, "pane still"),
    ("identity", {"seed": 43}, "identity")]:
    root, source, sibling, payload = setup(name, **patch)
    reject(root, payload, reason)
    assert os.path.isdir(source)
root, source, sibling, payload = setup("confirmation")
reject(root, {**payload, "confirm": False}, "CONFIRM_REQUIRED")
reject(root, {**payload, "approvedDestination": os.path.join(ROOT, "escape")}, "approved paths")
reject(root, {**payload, "outputDir": "work_dirs/cpsc/attempts/../outside"})
assert os.path.isdir(source)
root, source, sibling, payload = setup("collision")
os.makedirs(payload["approvedDestination"])
reject(root, payload, "already exists")
assert os.path.isdir(source)
root, source, sibling, payload = setup("parent-failure")
subprocess.run = lambda *args, **kw: types.SimpleNamespace(returncode=41, stderr="", stdout="")
reject(root, payload, "PARENT_CD_FAILED")
assert os.path.isdir(source) and not os.path.exists(payload["approvedDestination"])
subprocess.run = run_move
root, source, sibling, payload = setup("changed")
original_digest = failed_attempt_content_digest
def mutate_after_digest(target, on_progress=None):
    result = original_digest(target, on_progress)
    with open(os.path.join(target, "new.txt"), "w", encoding="utf-8") as stream: stream.write("changed")
    return result
failed_attempt_content_digest = mutate_after_digest
reject(root, payload, "changed during preflight")
assert os.path.isdir(source) and not os.path.exists(payload["approvedDestination"])
failed_attempt_content_digest = original_digest
root, source, sibling, payload = setup("link-guard")
original_islink = os.path.islink
os.path.islink = lambda file: file == source or original_islink(file)
reject(root, payload, "link or mount")
assert os.path.isdir(source)
os.path.islink = original_islink
print("verified exact move, identity, hashes, live process, paths, collisions and restart")
`, "utf8");
  const result = spawnSync("python", ["-X", "utf8", script], { encoding: "utf8", timeout: 10000, windowsHide: true });
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verified exact move/);
  } finally {
    // Remove the executable fixture from its active location by a verified, reversible file move.
    const scope = fs.realpathSync(root), parent = fs.realpathSync(path.dirname(script)), info = fs.lstatSync(script);
    assert.equal(scope, path.resolve(root)); assert.equal(parent, scope);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isFile(), true);
    const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const record = { type: "file", source: script, sourceRoot: scope, destinationRoot: path.join(scope, "clean_dir"),
      reason: "completed bounded Python fixture", discoveredAt: new Date().toISOString(), bytes: info.size, sha256: sha256(script) };
    assert.equal(fs.existsSync(record.destinationRoot), false);
    fs.mkdirSync(record.destinationRoot);
    const destination = path.join(record.destinationRoot, path.basename(script));
    assert.equal(fs.realpathSync(path.dirname(destination)), record.destinationRoot);
    assert.equal(fs.existsSync(destination), false); assert.equal(sha256(script), record.sha256);
    fs.renameSync(script, destination);
    assert.equal(fs.existsSync(script), false); assert.equal(sha256(destination), record.sha256);
    fs.writeFileSync(path.join(record.destinationRoot, "MANIFEST.md"), JSON.stringify({ ...record, destination }) + "\n", "utf8");
  }
});
