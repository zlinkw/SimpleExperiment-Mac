const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A actions.list live catalog): the fake returns a server-side table and the CLI must forward it
// verbatim — count is whatever the CURRENT host reports (the "174" figure is a saved documentation
// baseline, never a CLI constant), and a host WITHOUT actions.list must fail -32601/exit 3 instead of a
// baked-in fallback. There is no raw invoke passthrough anywhere: this suite also proves help and local
// refusals perform zero API calls (no mutating handler can be reached from the catalog surface).
// FIXTURE POLICY: zero cleanup; unique retained run directory.
const TOKEN = "actionscatalog-batch-token";
const PID = 6565;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-actionscatalog-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startActionsCatalogBackend({ withActionsList = true } = {}) {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "" };
  const methods = withActionsList ? ["status", "actions.list"] : ["status"];
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
      if (rpc.method === "actions.list") {
        // A live table of a hypothetical host: rows/total belong to THIS host, not to any saved baseline.
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { actions: [
          { command: "refreshResults", safe: true, confirm: false, action: "refresh-results" },
          { command: "runPlan", safe: false, confirm: true, action: "run-plan" },
          { command: "promoteDraft", safe: false, confirm: true, action: "" },
        ], count: 3 } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method unavailable: ${rpc.method}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "experiment-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("local refusals and help never touch the API from a foreign cwd", async () => {
  const cwd = fixtureDir("empty-cwd");
  const backend = await startActionsCatalogBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    for (const args of [["actions", "list", "extra-positional"], ["actions", "InvalidCatalog"], ["actions"], ["actions", "invoke", "runPlan"]]) {
      const result = await runCli([...args, "--json"], env);
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    const help = await runCli(["actions", "--help"], env);
    assert.equal(help.code, 0);
    assert.equal(backend.state.capabilitiesCalls, 0, "help/refusals must not call capabilities or any handler");
    assert.equal(backend.state.rpcCalls, 0, "there is no route from the catalog surface to a mutating handler");
  } finally { await backend.close(); }
});

test("actions list forwards the live table verbatim — count belongs to the current host", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startActionsCatalogBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const listed = await runCli(["actions", "list", "--json"], env);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { actions: [
      { command: "refreshResults", safe: true, confirm: false, action: "refresh-results" },
      { command: "runPlan", safe: false, confirm: true, action: "run-plan" },
      { command: "promoteDraft", safe: false, confirm: true, action: "" },
    ], count: 3 }, "rows and count are forwarded verbatim; confirm/safe/retirement hints come from the server, never a local table");
    assert.equal(backend.state.capabilitiesCalls, 1);
    assert.equal(backend.state.rpcCalls, 1);
    assert.equal(backend.state.lastMethod, "actions.list");
  } finally { await backend.close(); }
});

test("a host without actions.list fails explicitly (-32601, exit 3) with no local fallback table", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startActionsCatalogBackend({ withActionsList: false });
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const listed = await runCli(["actions", "list", "--json"], env);
    assert.equal(listed.code, 3, listed.stdout + listed.stderr); // capability-insufficient: explicit failure
    assert.match(listed.stdout, /-32601|Method unavailable/);
    assert.ok(!listed.stdout.includes("promoteDraft"), "no baked-in rows may masquerade as the live server table");
    assert.equal(backend.state.rpcCalls, 0, "the client preflight refuses the undeclared method before any RPC");
  } finally { await backend.close(); }
});

test("actions help separates the static text from live discovery and forbids raw invoke", async () => {
  const help = await runCli(["actions", "--help"]);
  assert.equal(help.code, 0);
  for (const probe of ["LIVE catalog", "STATIC", "removed raw API/invoke public entry remains unavailable", "never acceptance constants", "no local table is substituted"]) {
    assert.ok(help.stdout.includes(probe), `help must mention ${probe}`);
  }
  const overview = await runCli(["--help"]);
  assert.ok(overview.stdout.includes("actions      list | describe <kebab-name>"));
});
