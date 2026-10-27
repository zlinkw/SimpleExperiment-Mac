const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A agents.lifecycle): the fake mirrors the real handler gates at the RPC boundary — empty
// serverIds → AGENT_TARGET_REQUIRED, unknown action → AGENT_ACTION_INVALID, non-inspect without
// confirm===true → 2001 {requires:["confirm"]} with the target/tmux preview, migrate additionally
// requires per-target migrationDigests equal to the preview digests (:7960-7979). CLI coverage here is
// parameter passthrough + refusal shapes against this mock (NOT real-server proof: the confirmed paths
// touch real remote agents through the live host and are never exercised here). B's sftp agents
// lifecycle is a different contract tested separately and untouched by this suite.
// FIXTURE POLICY: zero cleanup; unique retained run directory.
const TOKEN = "agentslifecycle-batch-token";
const PID = 6464;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-agentslifecycle-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

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

function startAgentsLifecycleBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, mutations: 0 };
  const methods = ["status", "agents.lifecycle"];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods }));
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
  function handle(method, params) {
    if (method !== "agents.lifecycle") return { error: { code: -32601, message: `Method unavailable: ${method}` } };
    const ids = Array.isArray(params.serverIds) ? params.serverIds : [];
    if (!ids.length) return { error: { code: 2010, message: "AGENT_TARGET_REQUIRED: 必须明确 serverIds" } };
    const action = String(params.action || "inspect");
    if (!["inspect", "ensure", "stop", "restart", "migrate"].includes(action)) return { error: { code: 2010, message: "AGENT_ACTION_INVALID" } };
    if (action === "migrate") {
      const preview = ids.map((id) => ({ serverId: id, host: `h-${id}`, digest: DIGEST_A }));
      if (params.confirm !== true || preview.some((row) => params.migrationDigests?.[row.serverId] !== row.digest)) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { operation: "agents.lifecycle", requires: ["confirm", "migrationDigests"], preview: { action, targets: preview }, params: { action, serverIds: ids, migrationDigests: Object.fromEntries(preview.map((row) => [row.serverId, row.digest])) } } } };
      }
      state.mutations += 1;
      return { result: { ok: true, action, results: ids.map((id) => ({ id, status: "migrated" })) } };
    }
    if (action !== "inspect" && params.confirm !== true) {
      return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { operation: "agents.lifecycle", requires: ["confirm"], preview: { action, targets: ids.map((id) => ({ serverId: id })), tmuxTargets: ids.map((id) => ({ serverId: id, session: `simple-${id}-agent`, window: "agent" })) } } } };
    }
    if (action !== "inspect") state.mutations += 1;
    return { result: { ok: true, action, results: ids.map((id) => ({ id, status: action === "inspect" ? "ok" : "done" })) } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "experiment-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("input-deterministic refusals are local: zero capabilities, zero RPC, foreign cwd without root env", async () => {
  const cwd = fixtureDir("empty-cwd");
  const backend = await startAgentsLifecycleBackend();
  const dir = fixtureDir("refusals");
  const digestArray = writeJson(dir, "digest-array.json", [DIGEST_A]);
  const digestBadHex = writeJson(dir, "digest-badhex.json", { n1: "nothex" });
  const digestEmpty = writeJson(dir, "digest-empty.json", {});
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{oops", "utf8");
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    const zeroBefore = { c: backend.state.capabilitiesCalls, r: backend.state.rpcCalls };
    for (const args of [
      ["agents", "lifecycle", "inspect", "--json"], // AGENT_TARGET_REQUIRED fast path
      ["agents", "lifecycle", "inspect", "--server-ids", " , ", "--json"],
      ["agents", "lifecycle", "launch", "--server-ids", "n1", "--json"], // AGENT_ACTION_INVALID fast path
      ["agents", "lifecycle", "--server-ids", "n1", "--json"], // missing action
      ["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", digestArray, "--json"], // must be an object
      ["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", digestBadHex, "--json"], // 64-hex shape
      ["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", digestEmpty, "--json"],
      ["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", broken, "--json"],
      ["agents", "lifecycle", "inspect", "extra-positional", "--server-ids", "n1", "--json"],
      ["agents", "doctor", "--json"], // only the lifecycle subroute exists
    ]) {
      const result = await runCli([...args, "--json"], env);
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(backend.state.capabilitiesCalls, zeroBefore.c, "agents routes before the root probe: refusals read no capabilities/RPC");
    assert.equal(backend.state.rpcCalls, zeroBefore.r);
  } finally { await backend.close(); }
});

test("inspect is a zero-confirmation passthrough and mutations carry exactly {action,serverIds,confirm}", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startAgentsLifecycleBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const inspected = await runCli(["agents", "lifecycle", "inspect", "--server-ids", "n1,n2", "--json"], env);
    assert.equal(inspected.code, 0, inspected.stdout + inspected.stderr);
    assert.deepEqual(backend.state.lastParams, { action: "inspect", serverIds: ["n1", "n2"] }, "inspect sends only the real fields — no invented dirs/tmux/token params");
    assert.equal(JSON.parse(inspected.stdout).results.length, 2);
    assert.equal(backend.state.mutations, 0, "inspect never mutates (descriptor inspectZeroWrites)");

    const gated = await runCli(["agents", "lifecycle", "restart", "--server-ids", "n1", "--json"], env);
    assert.equal(gated.code, 2, gated.stdout + gated.stderr); // 2001 → ENV(2) with the full preview
    assert.match(gated.stdout, /"requires":\s*\[\s*"confirm"\s*\]/);
    assert.match(gated.stdout, /tmuxTargets/);
    assert.ok(!("confirm" in backend.state.lastParams), "confirm is forwarded only when the flag is given — never auto-filled");
    assert.equal(backend.state.mutations, 0);

    const stopped = await runCli(["agents", "lifecycle", "stop", "--server-ids", "n1", "--confirm", "--json"], env);
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    assert.deepEqual(backend.state.lastParams, { action: "stop", serverIds: ["n1"], confirm: true });
    assert.equal(backend.state.mutations, 1);
  } finally { await backend.close(); }
});

test("migrate requires confirm plus per-target digest echoes and answers 2001 with the expected digests", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startAgentsLifecycleBackend();
  const dir = fixtureDir("migrate");
  const wrong = writeJson(dir, "digest-wrong.json", { n1: "b".repeat(64) });
  const right = writeJson(dir, "digest-right.json", { n1: DIGEST_A });
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const first = await runCli(["agents", "lifecycle", "migrate", "--server-ids", "n1", "--json"], env);
    assert.equal(first.code, 2, first.stdout + first.stderr);
    assert.match(first.stdout, /"requires":\s*\[\s*"confirm",\s*"migrationDigests"\s*\]/);
    assert.ok(first.stdout.includes(DIGEST_A), "the preview echoes the expected digest so the operator can save and echo it");
    assert.equal(backend.state.mutations, 0);

    const mismatch = await runCli(["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", wrong, "--confirm", "--json"], env);
    assert.equal(mismatch.code, 2, mismatch.stdout + mismatch.stderr); // digest mismatch → backend preview, never a mutation
    assert.equal(backend.state.mutations, 0);

    const migrated = await runCli(["agents", "lifecycle", "migrate", "--server-ids", "n1", "--migration-digests", right, "--confirm", "--json"], env);
    assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
    assert.deepEqual(backend.state.lastParams, { action: "migrate", serverIds: ["n1"], migrationDigests: { n1: DIGEST_A }, confirm: true });
    assert.equal(JSON.parse(migrated.stdout).results[0].status, "migrated");
    assert.equal(backend.state.mutations, 1);
  } finally { await backend.close(); }
});

test("agents help documents A's four-field contract and stays separate from B's command", async () => {
  const help = await runCli(["agents", "--help"]);
  assert.equal(help.code, 0);
  for (const probe of ["agents lifecycle migrate --server-ids", "AGENT_TARGET_REQUIRED", "host-side setupConfig", "never sends or invents", "different command under simpleex sftp", "never auto-filled, never replayed"]) {
    assert.ok(help.stdout.includes(probe), `help must mention ${probe}`);
  }
  const overview = await runCli(["--help"]);
  assert.equal(overview.code, 0);
  assert.ok(overview.stdout.includes("agents       lifecycle inspect|ensure|stop|restart|migrate"));
});
