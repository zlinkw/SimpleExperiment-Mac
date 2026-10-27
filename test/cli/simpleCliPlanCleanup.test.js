const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A plans.cleanup.* family): the fake mirrors the real service-level branches at the RPC
// boundary — preview {planFile, action?, verifiedOnly?, continuationOf?, job?, authorizationMode?,
// reuseToken?, exactPaths?} (features/PlanCleanup.ts:743-744, authorizationMode is delete/isolate-only
// at :752), confirm {token, digest, phase, confirm, exactTargets} with the order-sensitive
// digest(echo)==digest(rows.filter(disposition==action).map(nodeId+":"+absolutePath)) and the
// delete-2/others-1 phase cap (:975-977), and execute gated on completed confirmations with
// idempotent completion (service.execute :1043-1051). cleanupError: CONFIRM_REQUIRED→2001 (exit 2),
// everything else 2010 (exit 3) (:119-121). These fake counters are stand-ins for the live
// extension host, never end-to-end production proof; nothing is moved or deleted anywhere real.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
const TOKEN = "plancleanup-batch-token";
const PID = 6262;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-plancleanup-fixtures-${Date.now()}-${process.pid}-`));
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

function startPlanCleanupBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, mutations: 0, confirmations: 0, executed: false };
  const methods = ["status", "plans.cleanup.preview", "plans.cleanup.continue", "plans.cleanup.recheck", "plans.cleanup.list", "plans.cleanup.confirm", "plans.cleanup.execute", "plans.cleanup.status", "plans.cleanup.resume", "plans.cleanup.cancel", "plans.cleanup.restore"];
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
  const previewRows = (action) => [
    { nodeId: "n1", node: { id: "n1" }, relativePath: "out/a.csv", type: "file", absolutePath: "/data/proj/out/a.csv", disposition: action },
    { nodeId: "n1", node: { id: "n1" }, relativePath: "shared", type: "directory", absolutePath: "/data/proj/shared", disposition: "protected" },
  ];
  const exactOf = (action) => previewRows(action).filter((row) => row.disposition === action).map((row) => row.node.id + ":" + row.absolutePath);
  function handle(method, params) {
    if (method === "plans.cleanup.list") return { result: [] };
    if (method === "plans.cleanup.preview") {
      const action = params.action || "move";
      if (!["move", "delete", "isolate"].includes(action)) return { error: { code: 2010, message: "INVALID_ACTION", data: { code: "INVALID_ACTION" } } };
      if (params.authorizationMode === "confirmed_paths" && !["delete", "isolate"].includes(action)) return { error: { code: 2010, message: "INVALID_ACTION", data: { code: "INVALID_ACTION" } } };
      return { result: { token: "tok-1", digest: "digest-1", action, rows: previewRows(action), blockers: [], verifiedOnly: params.verifiedOnly === true, confirmations: 0, expiresAt: Date.now() + 1800000 } };
    }
    if (method === "plans.cleanup.confirm") {
      const action = "move";
      const expected = exactOf(action);
      // :976-977 verbatim order-sensitive echo + phase cap (delete 2, others 1).
      if (params.confirm !== true || params.digest !== "digest-1"
        || JSON.stringify(params.exactTargets) !== JSON.stringify(expected)
        || params.phase !== state.confirmations + 1 || params.phase > (action === "delete" ? 2 : 1)) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { code: "CONFIRM_REQUIRED" } } };
      }
      state.confirmations = params.phase;
      return { result: { id: params.token, state: "ready", preview: { confirmations: params.phase } } };
    }
    if (method === "plans.cleanup.execute" || method === "plans.cleanup.resume") {
      if (state.executed) return { result: { id: params.operationId, state: "completed" } }; // idempotent (:1045/:1051)
      if (state.confirmations < 1) return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { code: "CONFIRM_REQUIRED" } } }; // (:1050)
      state.mutations += 1; state.executed = true;
      return { result: { id: params.operationId, state: "completed" } };
    }
    if (method === "plans.cleanup.status") return { result: { id: params.operationId, state: state.executed ? "completed" : "ready" } };
    if (method === "plans.cleanup.cancel") return { result: { id: params.operationId, state: "paused" } };
    if (method === "plans.cleanup.restore") return { result: { token: "restore-tok", action: "restore", rows: [] } };
    if (method === "plans.cleanup.continue") return { result: { token: "cont-tok", continuationOf: params.operationId, rows: [], verifiedOnly: params.verifiedOnly === true } };
    if (method === "plans.cleanup.recheck") return { result: [{ nodeId: params.nodeId, state: "pending" }] };
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

test("preview/list forward the full real parameter set; usage refusals are zero-API from a foreign cwd", async () => {
  const cwd = fixtureDir("empty-cwd"); // not an experiment project root; no root env is passed
  const backend = await startPlanCleanupBackend();
  const dir = fixtureDir("params");
  const jobFile = writeJson(dir, "job.json", { purpose: "replace_outputs", manifest: { declarations: [] } });
  const exactFile = writeJson(dir, "exact.json", [{ nodeId: "n1", relativePath: "out/a.csv", type: "file" }]);
  const badExact = writeJson(dir, "bad-exact.json", [{ nodeId: "n1", relativePath: "out/a.csv", type: "symlink" }]);
  const brokenJob = path.join(dir, "broken-job.json");
  fs.writeFileSync(brokenJob, "{oops", "utf8");
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    const listed = await runCli(["plan", "cleanup", "list", "--json"], env);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.deepEqual(backend.state.lastParams, {});

    const full = await runCli(["plan", "cleanup", "preview", "--plan-file", "experiments/plans/base.yaml", "--action", "delete",
      "--verified-only", "--continuation-of", "op-0", "--confirmed-paths", "--exact-paths", exactFile,
      "--reuse-token", "t-9", "--job", jobFile, "--json"], env);
    assert.equal(full.code, 0, full.stdout + full.stderr);
    assert.deepEqual(backend.state.lastParams, {
      planFile: "experiments/plans/base.yaml",
      action: "delete",
      verifiedOnly: true,
      continuationOf: "op-0",
      authorizationMode: "confirmed_paths",
      exactPaths: [{ nodeId: "n1", relativePath: "out/a.csv", type: "file" }],
      reuseToken: "t-9",
      job: { purpose: "replace_outputs", manifest: { declarations: [] } },
    });
    assert.equal(JSON.parse(full.stdout).token, "tok-1");

    const zeroBefore = { c: backend.state.capabilitiesCalls, r: backend.state.rpcCalls };
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{oops", "utf8");
    for (const args of [
      ["plan", "cleanup", "preview", "--json"], // missing --plan-file
      ["plan", "cleanup", "preview", "--plan-file", "p.yaml", "--action", "zap", "--json"], // bad action
      ["plan", "cleanup", "preview", "--plan-file", "p.yaml", "--confirmed-paths", "--json"], // confirmed_paths with default move (:752)
      ["plan", "cleanup", "preview", "--plan-file", "p.yaml", "--action", "delete", "--exact-paths", badExact, "--json"], // bad entry type
      ["plan", "cleanup", "preview", "--plan-file", "p.yaml", "--job", brokenJob, "--json"], // broken job JSON
      ["plan", "cleanup", "preview", "--plan-file", "p.yaml", "--job", broken, "--json"],
      ["plan", "cleanup", "teleport", "--json"], // unknown sub
      ["plan", "cleanup", "confirm", "--token", "t", "--digest", "d", "--phase", "0", "--targets", exactFile, "--json"], // phase < 1
      ["plan", "cleanup", "confirm", "--token", "t", "--digest", "d", "--phase", "1", "--json"], // missing --targets
      ["plan", "cleanup", "execute", "--json"], // missing --operation-id
      ["plan", "cleanup", "recheck", "--json"], // missing --node-id
    ]) {
      const result = await runCli([...args, "--json"], env);
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(backend.state.capabilitiesCalls, zeroBefore.c, "plan cleanup sits before the root probe: refusals must not read capabilities/RPC");
    assert.equal(backend.state.rpcCalls, zeroBefore.r);
  } finally { await backend.close(); }
});

test("confirm mirrors the order-sensitive nodeId:absolutePath echo and the phase cap", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startPlanCleanupBackend();
  const dir = fixtureDir("confirm");
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  const good = writeJson(dir, "echo.json", ["n1:/data/proj/out/a.csv"]); // preview-order, disposition==action rows only
  const wrongOrder = writeJson(dir, "order.json", ["n1:/data/proj/out/a.csv", "n1:/data/proj/shared"]); // includes protected row
  const base = ["plan", "cleanup", "confirm", "--token", "tok-1", "--digest", "digest-1", "--phase", "1"];
  try {
    // Without --confirm the CLI forwards confirm:false (the signature's boolean), never auto-filling.
    const noFlag = await runCli([...base, "--targets", good, "--json"], env);
    assert.equal(noFlag.code, 2, noFlag.stdout + noFlag.stderr); // CONFIRM_REQUIRED 2001 → ENV(2) preview
    assert.deepEqual(backend.state.lastParams, { token: "tok-1", digest: "digest-1", phase: 1, confirm: false, exactTargets: ["n1:/data/proj/out/a.csv"] });
    assert.equal(backend.state.confirmations, 0);

    // Echoing a protected row (or any reordered/extended set) fails the order-sensitive digest (:67/:976).
    const bad = await runCli([...base, "--targets", wrongOrder, "--confirm", "--json"], env);
    assert.equal(bad.code, 2, bad.stdout + bad.stderr);
    assert.equal(backend.state.confirmations, 0, "a wrong echo confirms nothing");

    const ok = await runCli([...base, "--targets", good, "--confirm", "--json"], env);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(backend.state.confirmations, 1);
    assert.equal(JSON.parse(ok.stdout).state, "ready");

    // move caps at one confirmation (delete would allow two) — a replayed phase hits the :977 cap.
    const replay = await runCli([...base, "--targets", good, "--confirm", "--json"], env);
    assert.equal(replay.code, 2);
    assert.equal(backend.state.confirmations, 1, "replays never advance or re-authorize");
  } finally { await backend.close(); }
});

test("execute gates on confirmations, completes idempotently, and the identity methods send only their real params", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startPlanCleanupBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    // :1050 — execute before the confirmations completed answers as CONFIRM_REQUIRED (2001 → exit 2), no mutation.
    const early = await runCli(["plan", "cleanup", "execute", "--operation-id", "op-7", "--json"], env);
    assert.equal(early.code, 2, early.stdout + early.stderr);
    assert.match(early.stdout, /CONFIRM_REQUIRED/);
    assert.equal(backend.state.mutations, 0);
    assert.deepEqual(backend.state.lastParams, { operationId: "op-7" }, "execute carries only the operation identity");

    const reread = await runCli(["plan", "cleanup", "status", "--operation-id", "op-7", "--json"], env);
    assert.equal(reread.code, 0);
    assert.deepEqual(backend.state.lastParams, { operationId: "op-7" });

    // Drive the real confirm chain, then execute once, then prove idempotent completion + resume alias.
    const dir = fixtureDir("exec");
    const good = writeJson(dir, "echo.json", ["n1:/data/proj/out/a.csv"]);
    const confirmed = await runCli(["plan", "cleanup", "confirm", "--token", "tok-1", "--digest", "digest-1", "--phase", "1", "--targets", good, "--confirm", "--json"], env);
    assert.equal(confirmed.code, 0, confirmed.stdout + confirmed.stderr);
    const executed = await runCli(["plan", "cleanup", "execute", "--operation-id", "op-7", "--json"], env);
    assert.equal(executed.code, 0, executed.stdout + executed.stderr);
    assert.equal(JSON.parse(executed.stdout).state, "completed");
    assert.equal(backend.state.mutations, 1);
    const again = await runCli(["plan", "cleanup", "execute", "--operation-id", "op-7", "--json"], env);
    assert.equal(again.code, 0);
    assert.equal(backend.state.mutations, 1, "a completed operation is answered idempotently, never re-executed (:1045/:1051)");
    const resumed = await runCli(["plan", "cleanup", "resume", "--operation-id", "op-7", "--json"], env);
    assert.equal(resumed.code, 0);
    assert.equal(backend.state.lastMethod, "plans.cleanup.resume");
    assert.equal(backend.state.mutations, 1);

    const cancelled = await runCli(["plan", "cleanup", "cancel", "--operation-id", "op-7", "--json"], env);
    assert.equal(cancelled.code, 0);
    assert.deepEqual(backend.state.lastParams, { operationId: "op-7" });
    const restored = await runCli(["plan", "cleanup", "restore", "--operation-id", "op-7", "--json"], env);
    assert.equal(restored.code, 0);
    assert.equal(backend.state.lastMethod, "plans.cleanup.restore");

    const continued = await runCli(["plan", "cleanup", "continue", "--operation-id", "op-7", "--verified-only", "--json"], env);
    assert.equal(continued.code, 0);
    assert.deepEqual(backend.state.lastParams, { operationId: "op-7", verifiedOnly: true });
    const rechecked = await runCli(["plan", "cleanup", "recheck", "--node-id", "gpu-node-1", "--json"], env);
    assert.equal(rechecked.code, 0);
    assert.deepEqual(backend.state.lastParams, { nodeId: "gpu-node-1" });
  } finally { await backend.close(); }
});

test("plan help documents the cleanup family and the exact echo contract", async () => {
  const help = await runCli(["plan", "--help"]);
  assert.equal(help.code, 0);
  for (const probe of ["plan cleanup preview", "plan cleanup confirm", "nodeId:absolutePath", "order-sensitive", "disposition==action", "delete confirms twice"]) {
    assert.match(help.stdout, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
