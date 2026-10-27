const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A tasks.preflight family): the fake mirrors src/extension/legacy.ts:14314-14362 —
// start requires workerId+commandId with strict booleans environmentOnly/completedOutputVerify,
// status/cancel require an operationId matching ^formal-preflight-[a-zA-Z0-9-]+$ (:14329) whose
// worker action must be preflight-worker-task (:14332). The backend defines no confirmation
// factors at this entry and the CLI invents none. Fake counters are stand-ins for the live
// worker channel — never end-to-end production proof; nothing is submitted anywhere real.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
const TOKEN = "preflight-batch-token";
const PID = 5151;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-preflight-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startPreflightBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, mutations: 0 };
  const methods = ["status", "tasks.preflight", "tasks.preflight.status", "tasks.preflight.cancel"];
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
    if (method === "tasks.preflight") {
      const workerId = String(params.workerId || "");
      if (!workerId) return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_WORKER_REQUIRED" } };
      if (!String(params.commandId || "")) return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_COMMAND_REQUIRED" } };
      if (params.environmentOnly !== undefined && typeof params.environmentOnly !== "boolean") return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_INVALID_ENVIRONMENT_ONLY" } };
      if (params.completedOutputVerify !== undefined && typeof params.completedOutputVerify !== "boolean") return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_INVALID_COMPLETED_OUTPUT" } };
      if (params.completedOutputVerify === true) return { error: { code: -32000, message: `WORKER_PROTOCOL_INCOMPATIBLE: ${workerId}: completedOutputPreflight` } };
      // The target-state gate is real backend business (never-started rejection); model one live refusal.
      if (String(params.commandId) === "never-started-missing") return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_REQUIRES_NEVER_STARTED_REJECTION" } };
      state.mutations += 1; // stands for the worker-side operation submission; nothing real was touched.
      return { result: { operationId: "formal-preflight-op-1", status: "submitted", workerId, targetCommandId: params.commandId, environmentOnly: params.environmentOnly === true } };
    }
    if (method === "tasks.preflight.status" || method === "tasks.preflight.cancel") {
      const operationId = String(params.operationId || "");
      if (!/^formal-preflight-[a-zA-Z0-9-]+$/.test(operationId)) return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_OPERATION_REQUIRED" } };
      if (method === "tasks.preflight.status") {
        if (operationId === "formal-preflight-gone") return { error: { code: -32000, message: "FORMAL_JOB_PREFLIGHT_OPERATION_MISMATCH" } };
        return { result: { operationId, action: "preflight-worker-task", state: "completed" } };
      }
      state.mutations += 1;
      return { result: { operationId, accepted: true, cancelOpId: "cancel-preflight-1" } };
    }
    return { error: { code: -32601, message: `Method unavailable: ${method}` } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "experiment-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("preflight start forwards exactly the real parameter shape", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startPreflightBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const plain = await runCli(["task", "preflight", "start", "--worker", "gpu-a", "--command", "cmd-7", "--json"], env);
    assert.equal(plain.code, 0, plain.stdout + plain.stderr);
    assert.deepEqual(backend.state.lastParams, { workerId: "gpu-a", commandId: "cmd-7" }, "booleans are omitted unless given; nothing is auto-filled");
    assert.equal(JSON.parse(plain.stdout).status, "submitted");

    const envOnly = await runCli(["task", "preflight", "start", "--worker", "gpu-a", "--command", "cmd-7", "--environment-only", "--json"], env);
    assert.equal(envOnly.code, 0, envOnly.stdout + envOnly.stderr);
    assert.deepEqual(backend.state.lastParams, { workerId: "gpu-a", commandId: "cmd-7", environmentOnly: true });

    // Live protocol gate surfaces as a business refusal with the worker's own reason, exit 3.
    const protocol = await runCli(["task", "preflight", "start", "--worker", "gpu-a", "--command", "cmd-7", "--completed-output-verify", "--json"], env);
    assert.equal(protocol.code, 3, protocol.stdout + protocol.stderr);
    assert.match(protocol.stdout, /WORKER_PROTOCOL_INCOMPATIBLE: gpu-a: completedOutputPreflight/);

    const neverStarted = await runCli(["task", "preflight", "start", "--worker", "gpu-a", "--command", "never-started-missing", "--json"], env);
    assert.equal(neverStarted.code, 3, neverStarted.stdout + neverStarted.stderr);
    assert.match(neverStarted.stdout, /FORMAL_JOB_PREFLIGHT_REQUIRES_NEVER_STARTED_REJECTION/);
    assert.equal(backend.state.mutations, 2);
  } finally { await backend.close(); }
});

test("preflight status/cancel enforce the operationId grammar before any RPC", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startPreflightBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const status = await runCli(["task", "preflight", "status", "--worker", "gpu-a", "--operation-id", "formal-preflight-op-1", "--json"], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.deepEqual(backend.state.lastParams, { workerId: "gpu-a", operationId: "formal-preflight-op-1" });

    const cancel = await runCli(["task", "preflight", "cancel", "--worker", "gpu-a", "--operation-id", "formal-preflight-op-1", "--json"], env);
    assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
    assert.equal(backend.state.lastMethod, "tasks.preflight.cancel");
    assert.deepEqual(backend.state.lastParams, { workerId: "gpu-a", operationId: "formal-preflight-op-1" });

    // Grammar (:14329) is input-deterministic: refused locally, zero RPC, same stated reason.
    const rpcBefore = backend.state.rpcCalls;
    for (const bad of ["op-1", "preflight-1", "formal-preflight-", "formal-preflight_OP_1"]) {
      const refused = await runCli(["task", "preflight", "status", "--worker", "gpu-a", "--operation-id", bad, "--json"], env);
      assert.equal(refused.code, 1, `${bad}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stdout + refused.stderr, /FORMAL_JOB_PREFLIGHT_OPERATION_REQUIRED/);
    }
    const missing = await runCli(["task", "preflight", "cancel", "--worker", "gpu-a", "--json"], env);
    assert.equal(missing.code, 1);
    assert.equal(backend.state.rpcCalls, rpcBefore, "grammar/missing-id refusals never reach the API");

    // A mismatched worker operation answers with the backend's own refusal (business exit 3).
    const gone = await runCli(["task", "preflight", "status", "--worker", "gpu-a", "--operation-id", "formal-preflight-gone", "--json"], env);
    assert.equal(gone.code, 3, gone.stdout + gone.stderr);
    assert.match(gone.stdout, /FORMAL_JOB_PREFLIGHT_OPERATION_MISMATCH/);
  } finally { await backend.close(); }
});

test("preflight usage refusals stay zero-API from a foreign cwd without any root env", async () => {
  const cwd = fixtureDir("empty-cwd"); // not an experiment project root
  const backend = await startPreflightBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    const noWorker = await runCli(["task", "preflight", "start", "--command", "cmd-7", "--json"], env);
    assert.equal(noWorker.code, 1);
    assert.match(noWorker.stdout + noWorker.stderr, /FORMAL_JOB_PREFLIGHT_WORKER_REQUIRED/);
    const noCommand = await runCli(["task", "preflight", "start", "--worker", "gpu-a", "--json"], env);
    assert.equal(noCommand.code, 1);
    const bogusSub = await runCli(["task", "preflight", "teleport", "--worker", "gpu-a", "--json"], env);
    assert.equal(bogusSub.code, 1);
    assert.match(bogusSub.stdout + bogusSub.stderr, /unknown task preflight subcommand/);
    assert.equal(backend.state.capabilitiesCalls, 0, "the task route must sit before the root probe: refusals must not read capabilities/RPC");
    assert.equal(backend.state.rpcCalls, 0);

    // Valid requests still work from the foreign cwd without root env: one preflight, one RPC each.
    const ok = await runCli(["task", "preflight", "status", "--worker", "gpu-a", "--operation-id", "formal-preflight-op-9", "--json"], env);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(backend.state.capabilitiesCalls, 1);
    assert.equal(backend.state.rpcCalls, 1);
  } finally { await backend.close(); }
});

test("task help lists the preflight family with its real grammar", async () => {
  const help = await runCli(["task", "--help"]);
  assert.equal(help.code, 0);
  for (const probe of ["preflight start", "preflight status", "completed-output-verify", "formal-preflight-", "none are invented"]) {
    assert.match(help.stdout, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const overview = await runCli(["--help"]);
  assert.match(overview.stdout, /task\s+dispatch \| analyze \| preflight/);
});
