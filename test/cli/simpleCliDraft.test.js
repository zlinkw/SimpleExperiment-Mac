const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A drafts domain): the fake mirrors src/extension/legacy.ts registrations exactly —
// drafts.list/cleanupCandidates {force} (:1534-1551), draftPlanPath params (:15614-15683),
// and the drafts.cleanup three-factor gate (confirm + pathConfirmed + confirmedPaths with the
// sorted absolute-path set equality at :15695-15698). These fake counters are stand-ins for the
// live extension host, not end-to-end production proof. No real drafts, moves, or writes occur.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
const TOKEN = "draft-batch-token";
const PID = 4242;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-draft-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);
const CANDIDATES = [
  { path: "tmp/plan/old-a.yaml", reason: "debug_completed" },
  { path: "tmp/plan/old-b.yaml", reason: "rejected" },
];

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
function draftEnv(root, file) {
  return { SIMPLE_EXPERIMENT_PROJECT_ROOT: root, SIMPLE_EXPERIMENT_MAC_API_FILE: file };
}

function startDraftBackend(projectRoot) {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, mutations: 0, promoteSeen: 0 };
  const methods = ["status", "drafts.list", "drafts.validate", "drafts.promotionPreview", "drafts.reject", "drafts.review", "drafts.cleanupCandidates", "drafts.cleanup"];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods, retiredMethods: { "drafts.promote": "DRAFT_PROMOTION_RETIRED" } }));
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
    if (method === "drafts.list") return { result: { enabled: true, drafts: CANDIDATES.map((c) => ({ draftPlanPath: c.path, status: c.reason })), cleanupCandidates: CANDIDATES, error: "", updatedAt: STARTED_AT } };
    if (method === "drafts.cleanupCandidates") return { result: { candidates: CANDIDATES } };
    if (method === "drafts.validate") {
      if (!String(params.draftPlanPath || "")) return { error: { code: -32000, message: "未找到草稿 PLAN：" } };
      // Real shape (legacy.ts:15614-15621): validation.ok:false is a SUCCESSFUL RPC with an in-band
      // business failure — the CLI must still exit BUSINESS(3) while printing the full report.
      if (String(params.draftPlanPath || "").endsWith("broken.yaml")) {
        return { result: { ok: false, status: "invalid", configRefs: ["configs/missing.yaml"], issues: ["缺少 config 引用：configs/missing.yaml"] } };
      }
      return { result: { ok: true, status: "validated", draftPlanPath: params.draftPlanPath, configRefs: [], issues: [] } };
    }
    if (method === "drafts.promotionPreview") {
      // Real gate (legacy.ts:15648-15652): only debug_completed/ready_for_review with a successful debug run previews.
      if (String(params.draftPlanPath || "").endsWith("running.yaml")) return { error: { code: -32000, message: "Debug 未成功结束，禁止转正：running" } };
      return { result: { source: "tmp/plan/done.yaml", targetPlan: "experiments/plans/done.yaml" } };
    }
    if (method === "drafts.review" || method === "drafts.reject") {
      const status = method === "drafts.review" ? "ready_for_review" : "rejected";
      return { result: { ok: true, status, draftPlanPath: params.draftPlanPath, reviewedBy: params.reviewedBy || "local-user" } };
    }
    if (method === "drafts.cleanup") {
      const requested = Array.isArray(params.paths) ? params.paths.map(String) : [];
      if (!requested.length) return { error: { code: -32000, message: "清理必须提供精确文件路径列表。" } };
      const selected = CANDIDATES.filter((item) => requested.includes(item.path));
      if (!selected.length || selected.length !== new Set(requested).size) return { error: { code: -32000, message: "草稿清理路径已变化；请重新获取候选列表后再确认。" } };
      const targets = selected.map((item) => ({ label: `${item.path} · ${item.reason}`, path: path.resolve(projectRoot, item.path), destination: path.resolve(projectRoot, "clean_dir", ...item.path.split("/")) }));
      // legacy.ts:15695-15698: sorted absolute confirmed set must equal the canonical candidate set.
      const confirmed = Array.isArray(params.confirmedPaths) ? params.confirmedPaths.map((value) => path.resolve(projectRoot, String(value))).sort() : [];
      if (params.confirm !== true || params.pathConfirmed !== true || JSON.stringify(confirmed) !== JSON.stringify(targets.map((item) => item.path).sort())) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { operation: "drafts.cleanup", requires: ["confirm", "pathConfirmed", "confirmedPaths"], targets, paths: requested } } };
      }
      state.mutations += 1;
      return { result: { ok: true, moved: requested.length, destinationRoot: path.resolve(projectRoot, "clean_dir") } };
    }
    if (method === "drafts.promote") {
      state.promoteSeen += 1; // must stay 0: the CLI refuses promote locally with zero RPC.
      return { error: { code: -32001, message: "DRAFT_PROMOTION_RETIRED" } };
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

test("draft list/candidates forward only the force flag", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  try {
    const listed = await runCli(["draft", "list", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.equal(backend.state.lastMethod, "drafts.list");
    assert.deepEqual(backend.state.lastParams, {});
    assert.equal(JSON.parse(listed.stdout).enabled, true);

    const forced = await runCli(["draft", "list", "--force", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.deepEqual(backend.state.lastParams, { force: true }, "force is forwarded verbatim; nothing else is invented");

    const candidates = await runCli(["draft", "candidates", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(candidates.code, 0, candidates.stdout + candidates.stderr);
    assert.equal(backend.state.lastMethod, "drafts.cleanupCandidates");
    assert.deepEqual(backend.state.lastParams, {});
    assert.deepEqual(JSON.parse(candidates.stdout).candidates.map((c) => c.path), ["tmp/plan/old-a.yaml", "tmp/plan/old-b.yaml"]);

    const extraPos = await runCli(["draft", "list", "unexpected", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(extraPos.code, 1);
    assert.equal(backend.state.rpcCalls, 3, "usage refusals never reach the API");
  } finally { await backend.close(); }
});

test("draft validate and promotion-preview send the real draftPlanPath parameter", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  try {
    const validated = await runCli(["draft", "validate", "tmp/plan/old-a.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(validated.code, 0, validated.stdout + validated.stderr);
    assert.deepEqual(backend.state.lastParams, { draftPlanPath: "tmp/plan/old-a.yaml" });
    assert.equal(JSON.parse(validated.stdout).status, "validated");

    // The backend's own promotion guard (debug not finished) surfaces as a business refusal, exit 3.
    const refused = await runCli(["draft", "promotion-preview", "tmp/plan/running.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /Debug 未成功结束，禁止转正/);

    const ok = await runCli(["draft", "promotion-preview", "tmp/plan/done.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(backend.state.lastMethod, "drafts.promotionPreview");

    // The real ok:false report (a successful RPC with an in-band failure) keeps full JSON but must
    // not exit 0; objects without an ok field (promotion preview below) still exit 0 normally.
    const invalid = await runCli(["draft", "validate", "tmp/plan/broken.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(invalid.code, 3, invalid.stdout + invalid.stderr);
    const report = JSON.parse(invalid.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, "invalid");
    assert.deepEqual(report.issues, ["缺少 config 引用：configs/missing.yaml"]);
    assert.deepEqual(report.configRefs, ["configs/missing.yaml"]);

    const noPath = await runCli(["draft", "validate", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(noPath.code, 1);
    assert.match(noPath.stdout + noPath.stderr, /exactly one <draftPlanPath>/);
    assert.equal(backend.state.rpcCalls, 4);
  } finally { await backend.close(); }
});

test("draft review/reject forward reviewedBy without inventing the backend default", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  try {
    const reviewed = await runCli(["draft", "review", "tmp/plan/old-a.yaml", "--reviewed-by", "zhang", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
    assert.deepEqual(backend.state.lastParams, { draftPlanPath: "tmp/plan/old-a.yaml", reviewedBy: "zhang" });
    assert.equal(JSON.parse(reviewed.stdout).status, "ready_for_review");

    // Without --reviewed-by the key is absent so the backend default ("local-user") applies.
    const rejected = await runCli(["draft", "reject", "tmp/plan/old-b.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(rejected.code, 0, rejected.stdout + rejected.stderr);
    assert.deepEqual(backend.state.lastParams, { draftPlanPath: "tmp/plan/old-b.yaml" });
    assert.equal(JSON.parse(rejected.stdout).reviewedBy, "local-user");

    const twoPaths = await runCli(["draft", "reject", "a.yaml", "b.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(twoPaths.code, 1);
    assert.equal(backend.state.rpcCalls, 2, "ambiguous positionals are refused before any RPC");
  } finally { await backend.close(); }
});

test("draft cleanup previews without factors, never auto-fills them, and closes with all three", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  const dir = fixtureDir("cleanup");
  const pathsFile = writeJson(dir, "paths.json", ["tmp/plan/old-a.yaml", "tmp/plan/old-b.yaml"]);
  const absolute = writeJson(dir, "confirmed.json", CANDIDATES.map((c) => path.resolve(root, c.path)));
  const drifted = writeJson(dir, "drift.json", [path.resolve(root, "tmp/plan/old-a.yaml"), path.resolve(root, "tmp/plan/renamed.yaml")]);
  try {
    const preview = await runCli(["draft", "cleanup", "--paths", pathsFile, "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(preview.code, 2, preview.stdout + preview.stderr); // CONFIRM_REQUIRED(2001) → ENV(2) preview
    assert.match(preview.stdout, /CONFIRM_REQUIRED/);
    assert.match(preview.stdout, /confirmedPaths/);
    assert.equal(backend.state.mutations, 0);

    // Supplying only --confirm must NOT be completed by the CLI: the sent params carry just that factor.
    const half = await runCli(["draft", "cleanup", "--paths", pathsFile, "--confirm", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(half.code, 2, half.stdout + half.stderr);
    assert.deepEqual(backend.state.lastParams, { paths: ["tmp/plan/old-a.yaml", "tmp/plan/old-b.yaml"], confirm: true });
    assert.equal(backend.state.mutations, 0, "confirmations are never auto-filled or replayed");

    const moved = await runCli(["draft", "cleanup", "--paths", pathsFile, "--confirmed-paths-file", absolute, "--confirm", "--path-confirmed", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(moved.code, 0, moved.stdout + moved.stderr);
    assert.equal(backend.state.mutations, 1);
    assert.equal(JSON.parse(moved.stdout).moved, 2);

    // A drifted absolute echo re-previews instead of moving (candidate set equality, :15695-15698).
    const stale = await runCli(["draft", "cleanup", "--paths", pathsFile, "--confirmed-paths-file", drifted, "--confirm", "--path-confirmed", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(stale.code, 2, stale.stdout + stale.stderr);
    assert.equal(backend.state.mutations, 1, "the drifted echo moved nothing");
  } finally { await backend.close(); }
});

test("draft cleanup usage refusals never touch the API", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  const dir = fixtureDir("usage");
  const emptyFile = writeJson(dir, "empty.json", []);
  const dupFile = writeJson(dir, "dup.json", ["tmp/plan/old-a.yaml", "tmp/plan/old-a.yaml"]);
  const brokenFile = path.join(dir, "broken.json");
  fs.writeFileSync(brokenFile, "{oops", "utf8");
  const objectFile = writeJson(dir, "object.json", [{ path: "tmp/plan/old-a.yaml" }]);
  try {
    const cases = [
      ["draft", "cleanup", "--json"],
      ["draft", "cleanup", "--paths", emptyFile, "--json"],
      ["draft", "cleanup", "--paths", dupFile, "--json"],
      ["draft", "cleanup", "--paths", brokenFile, "--json"],
      ["draft", "cleanup", "--paths", objectFile, "--json"],
      ["draft", "cleanup", "--paths", path.join(dir, "missing.json"), "--json"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { env: draftEnv(root, backend.file) });
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(backend.state.capabilitiesCalls, 0, "usage refusals must not open the API path at all");
    assert.equal(backend.state.rpcCalls, 0);
  } finally { await backend.close(); }
});

test("drafts.promote is refused locally: retired, zero RPC, never revived", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  try {
    const promoted = await runCli(["draft", "promote", "tmp/plan/old-a.yaml", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(promoted.code, 3, promoted.stdout + promoted.stderr);
    assert.match(promoted.stdout, /DRAFT_PROMOTION_RETIRED/);
    assert.equal(backend.state.rpcCalls, 0, "the CLI refuses promote before any transport call");
    assert.equal(backend.state.promoteSeen, 0);
  } finally { await backend.close(); }
});

test("draft routes before any root probe: foreign cwd without root env stays fully zero-API", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  const foreignCwd = fixtureDir("empty-cwd"); // not an experiment project root
  const brokenFile = path.join(foreignCwd, "broken.json");
  fs.writeFileSync(brokenFile, "{oops", "utf8");
  // No SIMPLE_EXPERIMENT_PROJECT_ROOT is passed: the pre-routing probe would otherwise fall back to
  // optionalApi("status") here and read capabilities/RPC before the refusals could even run.
  const bare = { cwd: foreignCwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    const promoted = await runCli(["draft", "promote", "tmp/plan/old-a.yaml", "--json"], bare);
    assert.equal(promoted.code, 3, promoted.stdout + promoted.stderr);
    assert.match(promoted.stdout, /DRAFT_PROMOTION_RETIRED/);

    const missing = await runCli(["draft", "--json"], bare);
    assert.equal(missing.code, 1);

    const badPaths = await runCli(["draft", "cleanup", "--paths", brokenFile, "--json"], bare);
    assert.equal(badPaths.code, 1);

    assert.equal(backend.state.capabilitiesCalls, 0, "usage and the local promote refusal must not touch the API even with valid discovery and a foreign cwd");
    assert.equal(backend.state.rpcCalls, 0);
    assert.equal(backend.state.promoteSeen, 0);

    // A legitimate request still works from the foreign cwd without any root env: one preflight, one RPC.
    const listed = await runCli(["draft", "list", "--json"], bare);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.equal(backend.state.capabilitiesCalls, 1);
    assert.equal(backend.state.rpcCalls, 1);
  } finally { await backend.close(); }
});

test("draft usage and help stay zero-API and list the named actions", async () => {
  const root = fixtureDir("project");
  const backend = await startDraftBackend(root);
  try {
    const missing = await runCli(["draft", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(missing.code, 1);
    const bogus = await runCli(["draft", "bogus", "--json"], { env: draftEnv(root, backend.file) });
    assert.equal(bogus.code, 1);
    assert.match(bogus.stdout + bogus.stderr, /unknown draft action/);
    assert.equal(backend.state.capabilitiesCalls, 0);

    const help = await runCli(["draft", "--help"]);
    assert.equal(help.code, 0);
    for (const probe of ["candidates", "promotion-preview", "reviewed-by", "confirmed-paths-file", "path-confirmed", "DRAFT_PROMOTION_RETIRED"]) {
      assert.match(help.stdout, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const overview = await runCli(["--help"]);
    assert.match(overview.stdout, /draft\s+list \| candidates/);
  } finally { await backend.close(); }
});
