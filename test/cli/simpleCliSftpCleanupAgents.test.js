const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 2c (surface suite): CLI-level behavior for files.cleanup.* and agents.lifecycle —
// usage guards with zero API side effects, verbatim parameter pass-through, and the agents entry.
// This fake is a stand-in: its counters prove routing/usage behavior only and are NOT an
// end-to-end production-safety proof. Engine confirmations, receipts, and delete semantics are
// proven against the real CleanupFileApi in simpleCliSftpCleanupEngine.test.js.
const TOKEN = "cleanup-surface-token";
const PID = 6789;
const STARTED_AT = "2026-03-03T03:33:33.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `sftp-cleanup-surface-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

// agent-lifecycle.js:19 agentPayload allowlist — the preview payload may only carry these keys
// (minus agentToken, which the real entry strips).
const AGENT_ALLOWLIST = ["action", "projectDir", "installDir", "stateDir", "workerStateDir", "mode", "workerId", "host", "port", "condaEnv", "expectedVersion", "files", "sessionPrefix", "tmuxSession", "tmuxWindow", "agentToken", "migrationDigest"];

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
const NODE = { kind: "remote", host: "gpu-node-1", port: 22, root: "/data/research/proj" };
// The real apiTransferSftp (extension.js) merges the active shared server under params.server;
// the fake models that fallback so "no --file" is a legitimate default-target call.
const ACTIVE_SERVER = { host: "default-active-node", port: 22, username: "researcher" };

function startSurfaceBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, agentRuns: 0 };
  const methods = ["status", "files.cleanup.inspect", "files.cleanup.observeBatch", "files.cleanup.preview", "files.cleanup.confirm", "files.cleanup.execute", "files.cleanup.status", "files.cleanup.check", "files.cleanup.verify", "files.cleanup.settle", "agents.lifecycle"];
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
      state.lastMethod = rpc.method;
      state.lastParams = rpc.params;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...handle(rpc.method, rpc.params || {}) }));
    });
  });
  const engineCode = (code) => ({ error: { code: code === "CONFIRM_REQUIRED" ? 2001 : 2010, message: code, data: { code } } });
  function handle(method, params) {
    // Stand-in responses: shape-correct, no engine state. Engine semantics live in the engine suite.
    if (method === "files.cleanup.inspect") {
      if (!params.node?.root || !["file", "directory"].includes(params.target?.type)) return engineCode("INVALID_REQUEST");
      return { result: { ok: true, rootIdentity: { dev: "42:1", ino: "7" }, target: { ...params.target, absolutePath: `${params.node.root}/${params.target.relativePath}` } } };
    }
    if (method === "files.cleanup.observeBatch") {
      if (!params.node?.root || typeof params.observationId !== "string" || !params.observationId
        || !Array.isArray(params.targets) || !params.targets.length || params.targets.length > 5000) return engineCode("INVALID_REQUEST");
      if (params.readConcurrency !== 1 && params.readConcurrency !== 2) return engineCode("INVALID_REQUEST");
      return { result: { ok: true, observationId: params.observationId, capabilities: { batchCleanupObservation: 1, maxTargets: 5000 }, observations: params.targets.map((target) => ({ key: target.key, state: "pending", executors: [], executorsChecked: true })) } };
    }
    if (method === "files.cleanup.preview") {
      if (!params.node?.root || !["move", "delete", "restore", "isolate"].includes(params.action) || !Array.isArray(params.targets) || !params.targets.length) return engineCode("INVALID_REQUEST");
      return { result: { ok: true, token: "a".repeat(48), operationId: "cleanup-standin", action: params.action, observationMode: params.observationMode === "managed_tmux" ? "tmux" : undefined, confirmations: 0, digest: "standin-digest", targets: params.targets, states: params.targets.map(() => "pending") } };
    }
    if (method === "files.cleanup.status") {
      if (!/^[a-f0-9]{48}$/.test(String(params.token))) return engineCode("INVALID_TOKEN");
      return { result: { ok: true, token: params.token, states: [], confirmations: 0 } };
    }
    if (["files.cleanup.confirm", "files.cleanup.execute", "files.cleanup.check", "files.cleanup.verify", "files.cleanup.settle"].includes(method)) {
      return { result: { ok: true, token: params.token } };
    }
    if (method === "agents.lifecycle") {
      if (!["inspect", "ensure", "stop", "restart", "migrate"].includes(params.action)) return { error: { code: -32000, message: "AGENT_ACTION_INVALID" } };
      if (params.mode !== "worker_telemetry" || !params.workerId) return { error: { code: -32000, message: "AGENT_IDENTITY_REQUIRED" } };
      // apiTransferSftp mirror: explicit params.server wins, otherwise the active shared server applies.
      const server = params.server && typeof params.server === "object" ? params.server : ACTIVE_SERVER;
      const host = String(server.host || "");
      if (!host) return { error: { code: -32000, message: "AGENT_TRANSPORT_REQUIRED" } };
      if (params.action !== "inspect" && (params.confirm !== true || params.pathConfirmed !== true)) {
        const payload = Object.fromEntries(AGENT_ALLOWLIST.filter((key) => key !== "agentToken" && params[key] !== undefined).map((key) => [key, params[key]]));
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { method: "agents.lifecycle", target: { host, port: server.port, user: server.username || server.user }, payload, requires: ["confirm", "pathConfirmed"] } } };
      }
      if (params.action !== "inspect") state.agentRuns += 1;
      return { result: { ok: true, action: params.action, state: params.action === "inspect" ? "running" : "applied", host } };
    }
    return { error: { code: -32601, message: `Method unavailable: ${method}` } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "sftp-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("cleanup pass-through: observationMode, rootIdentity, and per-target backend fields travel verbatim", async () => {
  const backend = await startSurfaceBackend();
  const dir = fixtureDir("passthrough");
  const nodeFile = writeJson(dir, "node.json", NODE);
  const targetsFile = writeJson(dir, "targets.json", [{ key: "k1", relativePath: "work_dirs/run1/out", type: "directory", backendToken: "b".repeat(48), backendIndex: 3, isolationRelativePath: "work_dirs/run1/.isolated-out" }]);
  const identityFile = writeJson(dir, "identity.json", { dev: "42:1", ino: "9" });
  try {
    const preview = await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "move", "--targets", targetsFile, "--observation-mode", "managed_tmux", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    assert.equal(backend.state.lastParams.observationMode, "managed_tmux", "cleanup-file-api.js:331 managed_tmux must reach the engine or the batch silently falls to the legacy activity gate");
    assert.equal(backend.state.lastParams.consumerRoot, dir, "r17-D: the consuming project root travels verbatim with every cleanup request");
    assert.equal(JSON.parse(preview.stdout).observationMode, "tmux", "engine derives tmux from the remote node kind");

    const badMode = await runCli(["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "move", "--targets", targetsFile, "--observation-mode", "tmux", "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(badMode.code, 1);
    assert.match(badMode.stdout + badMode.stderr, /knows only 'managed_tmux'/);

    const observe = await runCli(["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-9", "--targets", targetsFile, "--root-identity", identityFile, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(observe.code, 0, observe.stdout + observe.stderr);
    assert.deepEqual(backend.state.lastParams.rootIdentity, { dev: "42:1", ino: "9" });
    assert.equal(backend.state.lastParams.consumerRoot, dir, "r17-D: token-bearing observation rounds carry the owner root");
    assert.deepEqual(backend.state.lastParams.targets[0], { key: "k1", relativePath: "work_dirs/run1/out", type: "directory", backendToken: "b".repeat(48), backendIndex: 3, isolationRelativePath: "work_dirs/run1/.isolated-out" });

    const badIdentityFile = path.join(dir, "broken.json");
    fs.writeFileSync(badIdentityFile, "{oops", "utf8");
    const malformed = await runCli(["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-9", "--targets", targetsFile, "--root-identity", badIdentityFile, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stdout + malformed.stderr, /root identity must be valid JSON/);
  } finally { await backend.close(); }
});

test("agents lifecycle: explicit and default targets, payload allowlist, and the token never echoes", async () => {
  const backend = await startSurfaceBackend();
  const dir = fixtureDir("agents");
  const serverFile = writeJson(dir, "server.json", { host: "gpu-node-1", user: "researcher", remotePath: "/data/research/proj", port: 22 });
  const base = ["--project-dir", "/opt/research/agent", "--install-dir", "/opt/research/agent/install", "--worker-id", "nwpu2", "--port", "8321"];
  try {
    const inspect = await runCli(["sftp", "agents", "lifecycle", "inspect", ...base, "--file", serverFile, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(inspect.code, 0, inspect.stdout + inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).state, "running");
    assert.equal(backend.state.agentRuns, 0, "inspect must not run a mutation");

    const stopPreview = await runCli(["sftp", "agents", "lifecycle", "stop", ...base, "--file", serverFile, "--agent-token", "secret-agent-token-xyz", "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(stopPreview.code, 2, stopPreview.stdout + stopPreview.stderr);
    const detail = JSON.parse(stopPreview.stdout).error.detail;
    assert.deepEqual(detail.requires, ["confirm", "pathConfirmed"]);
    assert.ok(!stopPreview.stdout.includes("secret-agent-token-xyz") && !stopPreview.stderr.includes("secret-agent-token-xyz"), "agentToken must never travel back in the preview");
    // The preview payload mirrors agentPayload's fixed allowlist: no server/confirm/pathConfirmed leakage.
    for (const key of Object.keys(detail.payload)) assert.ok(AGENT_ALLOWLIST.includes(key), `payload key outside the agentPayload allowlist: ${key}`);
    for (const forbidden of ["server", "confirm", "pathConfirmed", "agentToken"]) assert.ok(!(forbidden in detail.payload), `preview payload must not carry ${forbidden}`);

    const stop = await runCli(["sftp", "agents", "lifecycle", "stop", ...base, "--file", serverFile, "--confirm", "--path-confirmed", "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(stop.code, 0, stop.stdout + stop.stderr);
    assert.equal(backend.state.agentRuns, 1);
    assert.equal(backend.state.lastParams.mode, "worker_telemetry");

    // No --file: the real entry falls back to the workspace/active target (apiTransferSftp merge).
    const defaulted = await runCli(["sftp", "agents", "lifecycle", "restart", ...base, "--expected-version", "1.2.3", "--files", writeJson(dir, "hashes.json", { "cluster_agent.py": "a".repeat(64), "cluster_scheduler.py": "b".repeat(64) }), "--confirm", "--path-confirmed", "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(defaulted.code, 0, defaulted.stdout + defaulted.stderr);
    assert.equal(JSON.parse(defaulted.stdout).host, "default-active-node", "missing --file must use the backend default target, not fail");
    assert.ok(!("server" in backend.state.lastParams), "the CLI must not invent a server key when --file is absent");
  } finally { await backend.close(); }
});

test("agents usage guards mirror validateAgentRequest with zero API calls", async () => {
  const backend = await startSurfaceBackend();
  const dir = fixtureDir("agents-usage");
  const serverFile = writeJson(dir, "server.json", { host: "gpu-node-1", user: "researcher", remotePath: "/data/research/proj", port: 22 });
  const good = ["--project-dir", "/opt/a", "--install-dir", "/opt/a/install", "--worker-id", "w1", "--port", "8321", "--file", serverFile];
  try {
    const cases = [
      [["sftp", "agents", "lifecycle", "destroy", ...good], /unknown agents lifecycle action/],
      [["sftp", "agents", "restart", ...good], /unknown agents action: restart/],
      [["sftp", "agents", "lifecycle", "inspect", "--install-dir", "/opt/a/install", "--worker-id", "w1", "--port", "8321", "--file", serverFile], /--project-dir/],
      [["sftp", "agents", "lifecycle", "inspect", "--project-dir", "relative/path", "--install-dir", "/opt/a/install", "--worker-id", "w1", "--port", "8321", "--file", serverFile], /invalid --project-dir/],
      [["sftp", "agents", "lifecycle", "inspect", "--project-dir", "/opt/a", "--install-dir", "/opt/a/install", "--port", "8321", "--file", serverFile], /--worker-id/],
      [["sftp", "agents", "lifecycle", "inspect", "--project-dir", "/opt/a", "--install-dir", "/opt/a/install", "--worker-id", "w1", "--port", "0", "--file", serverFile], /--port/],
      [["sftp", "agents", "lifecycle", "inspect", ...good, "--tmux-session", "no-suffix"], /invalid --tmux-session/],
      [["sftp", "agents", "lifecycle", "inspect", ...good, "--tmux-window", ".bad"], /invalid --tmux-window/],
      [["sftp", "agents", "lifecycle", "migrate", ...good, "--confirm", "--path-confirmed"], /migration-digest <64 hex>/],
      [["sftp", "agents", "lifecycle", "migrate", ...good, "--migration-digest", "abc", "--confirm", "--path-confirmed"], /migration-digest <64 hex>/],
      [["sftp", "agents", "lifecycle", "ensure", ...good, "--confirm", "--path-confirmed"], /--expected-version/],
      [["sftp", "agents", "lifecycle", "ensure", ...good, "--expected-version", "1.2.3", "--confirm", "--path-confirmed"], /--files <hashes.json>/],
      [["sftp", "agents", "lifecycle", "ensure", ...good, "--expected-version", "1.2.3", "--files", writeJson(dir, "partial.json", { "cluster_agent.py": "a".repeat(64) }), "--confirm", "--path-confirmed"], /cluster_scheduler\.py/],
    ];
    for (const [args, probe] of cases) {
      const result = await runCli([...args, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, probe);
    }
    assert.equal(backend.state.capabilitiesCalls, 0, "agent usage guards must not open the API path");
    assert.equal(backend.state.rpcCalls, 0);
  } finally { await backend.close(); }
});

test("cleanup usage refusals never open the API path and unknown tokens answer with the engine code", async () => {
  const backend = await startSurfaceBackend();
  const dir = fixtureDir("cleanup-usage");
  const nodeFile = writeJson(dir, "node.json", NODE);
  const badTarget = writeJson(dir, "target.json", { relativePath: "x", type: "symlink" });
  try {
    const cases = [
      ["sftp", "cleanup", "inspect", "--file", nodeFile],
      ["sftp", "cleanup", "inspect", "--file", nodeFile, "--target", badTarget],
      ["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--observation-id", "obs-1", "--targets", writeJson(dir, "t.json", [{ key: "k1", relativePath: "a", type: "file" }]), "--read-concurrency", "3"],
      ["sftp", "cleanup", "observe-batch", "--file", nodeFile, "--targets", writeJson(dir, "t.json", [{ key: "k1", relativePath: "a", type: "file" }])],
      ["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "delete"],
      ["sftp", "cleanup", "status"],
      ["sftp", "cleanup", "check", "--token", "a".repeat(48)],
      ["sftp", "cleanup", "confirm", "--token", "a".repeat(48), "--digest", "d", "--phase", "0", "--targets", writeJson(dir, "t.json", []), "--confirm"],
      ["sftp", "cleanup", "nuke"],
    ];
    for (const args of cases) {
      const result = await runCli([...args, "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    // r17-D: every token-consuming subcommand refuses a missing --consumer-root at the CLI gate, still without opening the API path.
    for (const args of [["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "move", "--targets", writeJson(dir, "cr.json", [{ relativePath: "x", type: "file", destination: "clean_dir/x" }])],
      ["sftp", "cleanup", "status", "--token", "a".repeat(48)],
      ["sftp", "cleanup", "execute", "--token", "a".repeat(48), "--digest", "d", "--index", "0"],
      ["sftp", "cleanup", "preview", "--file", nodeFile, "--action", "move", "--targets", writeJson(dir, "cr2.json", [{ relativePath: "y", type: "file", destination: "clean_dir/y" }]), "--consumer-root", "relative/root"]]) {
      const result = await runCli([...args, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, /--consumer-root/, `${args.join(" ")} must refuse a missing/relative consumer root at the CLI`);
    }
    assert.equal(backend.state.capabilitiesCalls, 0, "usage refusals must not open the API path");
    assert.equal(backend.state.rpcCalls, 0);
    const stale = await runCli(["sftp", "cleanup", "status", "--token", "z".repeat(48), "--consumer-root", dir, "--json"], { env: { SIMPLE_SFTP_MAC_API_FILE: backend.file } });
    assert.equal(stale.code, 3, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /INVALID_TOKEN/);
  } finally { await backend.close(); }
});

test("help lists the batch 2c cleanup and agents entries", async () => {
  const result = await runCli(["sftp", "--help"]);
  assert.equal(result.code, 0);
  for (const probe of ["cleanup inspect", "cleanup observe-batch", "cleanup preview", "cleanup confirm", "cleanup execute", "cleanup status", "agents lifecycle", "migration-digest", "cluster_agent.py", "--observation-mode", "--root-identity"]) {
    assert.ok(result.stdout.includes(probe), `missing help probe: ${probe}`);
  }
});
