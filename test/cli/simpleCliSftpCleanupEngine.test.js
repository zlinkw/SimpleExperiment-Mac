const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 2c (engine suite): the CLI talks to the REAL CleanupFileApi from the companion
// SimpleSFTP source tree (read-only input, pinned by the run's requiredFiles+SHA manifest).
// The tree is an explicit cross-platform configuration — SIMPLE_TEST_SFTP_ROOT must point at
// the checkout root (absolute, normalized directory containing cleanup-file-api.js), injected
// per environment (Linux acceptance: /repos/MCP/simple-sftp-unified-cli-20261023 via
// --env-file; a Windows checkout passes its own real path the same way). Nothing is guessed,
// copied, or resolved through the Git metadata. Missing/bad configuration fails loudly — no skip.
// Only the lowest layer is stubbed: transport (the cleanup-files.py channel — no SSH, no
// deletion ever), activity, and lease. storageRoot is a unique retained tmp directory. This
// proves the real engine's parameter, confirmation, receipt, and state semantics end-to-end
// behind the CLI; the surface suite's fake counters are stand-ins and make no such claim.
function companionEngineFile() {
  const configured = String(process.env.SIMPLE_TEST_SFTP_ROOT || "").trim();
  if (!configured) throw new Error("SIMPLE_TEST_SFTP_ROOT is not set: point it at the SimpleSFTP source checkout root (the directory containing cleanup-file-api.js); see docs/unified-cli-coverage.md acceptance prerequisites");
  if (!path.isAbsolute(configured)) throw new Error(`SIMPLE_TEST_SFTP_ROOT must be an absolute directory, got: ${configured}`);
  const normalized = path.resolve(configured); // path API: drive letters, UNC, and separators resolve per-platform
  if (normalized !== configured) throw new Error(`SIMPLE_TEST_SFTP_ROOT must be normalized (path.resolve equal), got: ${configured} (normalized: ${normalized})`);
  const engineFile = path.join(normalized, "cleanup-file-api.js");
  if (!fs.existsSync(engineFile) || !fs.statSync(engineFile).isFile()) throw new Error(`companion SimpleSFTP source missing: ${engineFile}`);
  return engineFile;
}
const { CleanupFileApi } = require(companionEngineFile());

const TOKEN = "cleanup-engine-token";
const PID = 7788;
const STARTED_AT = "2026-04-04T04:44:44.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `sftp-cleanup-engine-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);
const NODE = { kind: "remote", host: "gpu-node-1", port: 22, root: "/data/research/proj" };
const ROOT_ID = { dev: "42:1", ino: "9" };
const BATCH = "job-" + "a".repeat(48);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function startEngineBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, deleteFastCalls: 0, deleteFastFail: null, gone: new Set(), actions: [] };
  const storageRoot = path.join(FIXTURE_ROOT, `storage-${Date.now()}`);
  fs.mkdirSync(storageRoot, { recursive: true });
  const transport = async (request) => {
    state.actions.push(request.action);
    const root = request.node.root;
    if (request.action === "inspect" || request.action === "inventory") {
      const t = request.target;
      return { ok: true, rootIdentity: ROOT_ID, target: { relativePath: t.relativePath, type: t.type, absolutePath: `${root}/${t.relativePath}`, device: "42:1", inode: "100", fingerprint: "f".repeat(64) } };
    }
    if (request.action === "batch-inspect") {
      return { ok: true, rootIdentity: ROOT_ID, targets: request.targets.map((t) => ({ relativePath: t.relativePath, type: t.type, absolutePath: `${root}/${t.relativePath}`, archived: false, device: "42:1", inode: "100", missing: state.gone.has(t.relativePath) || undefined })), metrics: { entryReads: request.targets.length } };
    }
    if (request.action === "delete-fast") {
      if (state.deleteFastFail) throw state.deleteFastFail;
      state.deleteFastCalls += 1;
      for (const entry of request.entries) state.gone.add(entry.relativePath);
      return { ok: true, receipt: { operationId: request.operationId, deleted: request.entries.length, metrics: { unlinked: request.entries.length } } };
    }
    if (request.action === "batch-verify") {
      return { ok: true, targets: request.entries.map((e) => ({ relativePath: e.relativePath, type: e.type, status: state.gone.has(e.relativePath) ? "gone" : "present" })) };
    }
    if (request.action === "batch-observe") {
      return { ok: true, observationId: request.observationId, rootIdentity: request.rootIdentity || ROOT_ID, observations: request.entries.map((e) => ({ key: e.key, status: state.gone.has(e.relativePath) ? "gone" : "present", executors: [], executorsChecked: true })) };
    }
    throw Object.assign(new Error(`STUB_ACTION_${request.action}`), { code: `STUB_ACTION_${request.action}` });
  };
  const engine = new CleanupFileApi({ storageRoot, transport, activity: async () => {}, lease: (node, targets, work) => work() });
  const methods = ["files.cleanup.inspect", "files.cleanup.observeBatch", "files.cleanup.preview", "files.cleanup.confirm", "files.cleanup.execute", "files.cleanup.status", "files.cleanup.check", "files.cleanup.verify", "files.cleanup.settle"];
  const dispatch = { "files.cleanup.inspect": (p) => engine.inspect(p), "files.cleanup.observeBatch": (p) => engine.observeBatch(p), "files.cleanup.preview": (p) => engine.preview(p), "files.cleanup.confirm": (p) => engine.confirm(p), "files.cleanup.execute": (p) => engine.execute(p), "files.cleanup.status": (p) => engine.status(p), "files.cleanup.check": (p) => engine.check(p), "files.cleanup.verify": (p) => engine.verify(p), "files.cleanup.settle": (p) => engine.settle(p) };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.rpcCalls += 1;
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = dispatch[rpc.method];
      if (!call) { res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method unavailable: ${rpc.method}` } })); return; }
      call(rpc.params || {}).then((result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))).catch((error) => {
        // Same mapping as the live local API: engine fail() carries apiCode 2001/2010 + apiData.
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: error.apiCode || -32000, message: error.message, data: error.apiData || {} } }));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "sftp-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, engine, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("real engine refuses an unarchived plain delete and caps move at one confirmation", async () => {
  const backend = await startEngineBackend();
  const dir = fixtureDir("guards");
  const nodeFile = writeJson(dir, "node.json", NODE);
  try {
    // cleanup-file-api.js:355-358: a plain (non confirmed-path) delete must name its archive destination.
    const plainDelete = writeJson(dir, "plain.json", [{ relativePath: "tmp/exec.csv", type: "file" }]);
    const refused = await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "delete", "--targets", plainDelete, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /UNSAFE_DESTINATION/);
    assert.equal(backend.state.deleteFastCalls, 0);

    const moved = writeJson(dir, "move.json", [{ relativePath: "tmp/m.csv", type: "file", destination: `clean_dir/${BATCH}/tmp/m.csv`, archiveBatch: BATCH }]);
    const preview = await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "move", "--targets", moved, "--observation-mode", "managed_tmux", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    const row = JSON.parse(preview.stdout);
    assert.equal(row.observationMode, "tmux", "managed_tmux on a remote node derives the tmux observation mode (cleanup-file-api.js:331)");
    const abs = writeJson(dir, "abs.json", row.targets.map((t) => t.absolutePath));
    const phase1 = await runCli(["sftp", "cleanup", "confirm", "--token", row.token, "--digest", row.digest, "--phase", "1", "--targets", abs, "--confirm", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(phase1.code, 0, phase1.stdout + phase1.stderr);
    const phase2 = await runCli(["sftp", "cleanup", "confirm", "--token", row.token, "--digest", row.digest, "--phase", "2", "--targets", abs, "--confirm", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(phase2.code, 2); // move confirms once; only delete reaches phase 2
    assert.match(phase2.stdout, /CONFIRM_REQUIRED/);
  } finally { await backend.close(); }
});

test("confirmed-path delete: two confirmations, one batch execution, replay answers from the receipt", async () => {
  const backend = await startEngineBackend();
  const dir = fixtureDir("lifecycle");
  const nodeFile = writeJson(dir, "node.json", NODE);
  // confirmed-path deletes reach only registered isolated artifact subtrees (cleanup-file-api.js:384-386):
  // a clean_dir/ path must be a job-<48hex> archive batch, and its destination echoes the original.
  const archived = `clean_dir/${BATCH}/old-run`;
  const targets = writeJson(dir, "targets.json", [{ relativePath: archived, type: "directory", destination: archived }, { relativePath: "data/drop.csv", type: "file" }]);
  try {
    const preview = await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "delete", "--targets", targets, "--confirmed-paths", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    const row = JSON.parse(preview.stdout);
    assert.equal(row.authorizationMode, "confirmed_paths");
    const abs = writeJson(dir, "abs.json", row.targets.map((t) => t.absolutePath));
    const drifted = writeJson(dir, "drift.json", [row.targets[0].absolutePath, "/data/research/proj/data/renamed.csv"]);
    const drift = await runCli(["sftp", "cleanup", "confirm", "--token", row.token, "--digest", row.digest, "--phase", "1", "--targets", drifted, "--confirm", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(drift.code, 2, drift.stdout + drift.stderr); // exact-path echo mismatch → fresh preview required
    assert.match(drift.stdout, /CONFIRM_REQUIRED/);
    for (const phase of ["1", "2"]) {
      const done = await runCli(["sftp", "cleanup", "confirm", "--token", row.token, "--digest", row.digest, "--phase", phase, "--targets", abs, "--confirm", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
      assert.equal(done.code, 0, done.stdout + done.stderr);
      assert.equal(JSON.parse(done.stdout).confirmations, Number(phase));
    }
    const executed = await runCli(["sftp", "cleanup", "execute", "--token", row.token, "--digest", row.digest, "--index", "0", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(executed.code, 0, executed.stdout + executed.stderr);
    assert.equal(backend.state.deleteFastCalls, 1, "the whole confirmed batch runs as one delete-fast call");
    assert.deepEqual(backend.state.gone, new Set([archived, "data/drop.csv"]));
    const replay = await runCli(["sftp", "cleanup", "execute", "--token", row.token, "--digest", row.digest, "--index", "1", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(replay.code, 0);
    assert.equal(JSON.parse(replay.stdout).alreadyCompleted, true);
    assert.equal(backend.state.deleteFastCalls, 1, "a completed batch is answered from the stored receipt, never re-executed");
    const status = await runCli(["sftp", "cleanup", "status", "--token", row.token, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(status.code, 0);
    assert.deepEqual(JSON.parse(status.stdout).states, ["completed", "completed"]);
  } finally { await backend.close(); }
});

test("uncertain receipt: partial mutation never reports completion until verify proves it", async () => {
  const backend = await startEngineBackend();
  const dir = fixtureDir("uncertain");
  const nodeFile = writeJson(dir, "node.json", NODE);
  const targets = writeJson(dir, "targets.json", [{ relativePath: "data/a.csv", type: "file" }, { relativePath: "data/b.csv", type: "file" }]);
  try {
    const row = JSON.parse((await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "delete", "--targets", targets, "--confirmed-paths", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } })).stdout);
    const abs = writeJson(dir, "abs.json", row.targets.map((t) => t.absolutePath));
    for (const phase of ["1", "2"]) {
      const done = await runCli(["sftp", "cleanup", "confirm", "--token", row.token, "--digest", row.digest, "--phase", phase, "--targets", abs, "--confirm", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
      assert.equal(done.code, 0, done.stdout + done.stderr);
    }
    // The engine refuses to call a mid-walk failure retryable: mutationStarted stays truthy.
    backend.state.deleteFastFail = Object.assign(new Error("ENTRY_IDENTITY_CHANGED"), { code: "ENTRY_IDENTITY_CHANGED", mutationStarted: true });
    const failed = await runCli(["sftp", "cleanup", "execute", "--token", row.token, "--digest", row.digest, "--index", "0", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(failed.code, 3, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /ENTRY_IDENTITY_CHANGED/);
    assert.equal(backend.state.deleteFastCalls, 0);
    const again = await runCli(["sftp", "cleanup", "execute", "--token", row.token, "--digest", row.digest, "--index", "0", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(again.code, 3);
    assert.match(again.stdout, /DELETE_RECEIPT_UNCERTAIN/); // no blind resend (cleanup-file-api.js:732)
    const verified = await runCli(["sftp", "cleanup", "verify", "--token", row.token, "--index", "0", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(verified.code, 3, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /CLEANUP_NOT_VERIFIED/); // fast-chain verify answers by live facts, not the frozen row
  } finally { await backend.close(); }
});

test("observe-batch binds frozen backend tokens per target; drift and cross-root answer as unknown", async () => {
  const backend = await startEngineBackend();
  const dir = fixtureDir("observe");
  const nodeFile = writeJson(dir, "node.json", NODE);
  const targets = writeJson(dir, "targets.json", [{ relativePath: "data/x.csv", type: "file" }]);
  const identityFile = writeJson(dir, "identity.json", ROOT_ID);
  const wrongIdentity = writeJson(dir, "wrong-identity.json", { dev: "99:9", ino: "1" });
  try {
    const row = JSON.parse((await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "delete", "--targets", targets, "--confirmed-paths", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } })).stdout);
    const bound = writeJson(dir, "bound.json", [{ key: "k1", relativePath: "data/x.csv", type: "file", backendToken: row.token, backendIndex: 0 }]);
    const ok = await runCli(["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-1", "--targets", bound, "--root-identity", identityFile, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.ok(!ok.stdout.includes("TOKEN_"), "a frozen token+index that matches the row must observe cleanly");
    const drifted = writeJson(dir, "drift.json", [{ key: "k1", relativePath: "data/other.csv", type: "file", backendToken: row.token, backendIndex: 0 }]);
    const mismatch = await runCli(["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-2", "--targets", drifted, "--root-identity", identityFile, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(mismatch.code, 0);
    assert.match(mismatch.stdout, /TOKEN_TARGET_MISMATCH/);
    const crossRoot = await runCli(["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-3", "--targets", bound, "--root-identity", wrongIdentity, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(crossRoot.code, 0);
    assert.match(crossRoot.stdout, /TOKEN_NODE_MISMATCH/);
  } finally { await backend.close(); }
});
