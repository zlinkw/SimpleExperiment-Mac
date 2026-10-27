const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");
const PluginLogRetention = require("../../dist/features/PluginLogRetention.js");
const { readSource } = require("../_helpers/sourceReader");

function job(index, attempt, status, extra = {}) {
  return { index, case: "c", seed: 1, attempt, status, outputDir: "out", ...extra };
}
function plan(id, enqueuedAt, planFile, jobs) {
  return { id, planFile, enqueuedAt, jobs };
}
function queueOf(plans) {
  return { schemaVersion: 1, plans };
}
const indexPath = index => index.rows.map(row => row.path);

test("exact manifest paths: only generations beyond current+previous become stale rows", () => {
  const queue = queueOf([
    plan("run-aaaaaaaa", "2026-10-01T10:00:00Z", "plans/a.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/command-old1.log" })]),
    plan("run-bbbbbbbb", "2026-10-02T10:00:00Z", "plans/a.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/command-old2.log" })]),
    plan("run-cccccccc", "2026-10-03T10:00:00Z", "plans/a.yaml", [job(0, 0, "cancelled", { logPath: "simple_cluster/tmp/tmux_logs/command-old3.log" })]),
    plan("run-dddddddd", "2026-10-04T10:00:00Z", "plans/a.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/command-new.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  // Newest two generations (10-04, 10-03) retained; the two older terminal generations are proposed.
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/command-old1.log"), true);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/command-old2.log"), true);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/command-old3.log"), false);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/command-new.log"), false);
});

test("active, paused and unknown generations are never proposed, even with trusted terminal facts", () => {
  const queue = queueOf([
    plan("run-00000001", "2026-10-05T10:00:00Z", "p.yaml", [job(0, 2, "running", { trustedTerminalStatus: "completed", logPath: "simple_cluster/tmp/console_logs/p/live.log" })]),
    plan("run-00000002", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 1, "paused", { logPath: "simple_cluster/tmp/console_logs/p/paused.log" })]),
    plan("run-00000003", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "unknown", { logPath: "simple_cluster/tmp/console_logs/p/unknown.log" })]),
    plan("run-00000004", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/console_logs/p/dead1.log" })]),
    plan("run-00000005", "2026-10-01T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/console_logs/p/dead2.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  const paths = indexPath(index);
  assert.equal(paths.includes("simple_cluster/tmp/console_logs/p/live.log"), false);
  assert.equal(paths.includes("simple_cluster/tmp/console_logs/p/paused.log"), false);
  assert.equal(paths.includes("simple_cluster/tmp/console_logs/p/unknown.log"), false);
  // The two dead generations are outside the window: the trusted-terminal live row and paused row
  // occupy the retained slots, and every proposed path must be terminal AND beyond the window.
  assert.equal(paths.includes("simple_cluster/tmp/console_logs/p/dead1.log"), true);
});

test("worker and GPU reassignment inside one attempt shares a single generation", () => {
  const reassigned = job(0, 1, "failed", { logPath: "simple_cluster/tmp/tmux_logs/attempt1.log", workerId: "gpu-node-b", gpuId: "3",
    history: [{ attempt: 1, status: "failed", commandId: "cmd-x", outputDir: "out" }] });
  const queue = queueOf([
    plan("run-x", "2026-10-03T10:00:00Z", "p.yaml", [reassigned]),
    plan("run-y", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/gen1.log", tmuxSession: "sess-one" })]),
    plan("run-z", "2026-10-01T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/gen0.log", tmuxSession: "sess-zero" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  // Generations: 10-03/attempt1 (retained newest), 10-02 (retained previous), 10-01 (stale).
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/gen0.log"), true);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/gen1.log"), false);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/attempt1.log"), false);
  // tmux sessions join ownership: only stale sessions are proposed; protected ones never.
  assert.equal(index.staleSessions.has("sess-zero"), true);
  assert.equal(index.protectedSessions.has("sess-one"), true);
});

test("retries inside one run share a single generation and never age out by themselves", () => {
  const attempts = [];
  for (let attempt = 0; attempt <= 12; attempt++)
    attempts.push(job(0, attempt, "failed", { logPath: `simple_cluster/tmp/tmux_logs/att-${attempt}.log` }));
  const queue = queueOf([
    plan("run-many", "2026-10-05T10:00:00Z", "p.yaml", attempts),
    plan("run-prev", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 2, "completed", { logPath: "simple_cluster/tmp/tmux_logs/prev-live.log" })]),
    plan("run-old", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/old-run.log" })]),
    plan("run-older", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/older-run.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  // All 13 retry logs belong to the newest run: one generation, fully retained.
  for (let attempt = 0; attempt <= 12; attempt++)
    assert.equal(indexPath(index).includes(`simple_cluster/tmp/tmux_logs/att-${attempt}.log`), false, `attempt ${attempt} must share the run generation`);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/prev-live.log"), false);
  // Distinct RUNS still age out: the two older runs leave the window together.
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/old-run.log"), true);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/older-run.log"), true);
});

test("extra batches appended to the same run id share one generation slot", () => {
  const queue = queueOf([
    plan("run-b", "2026-10-05T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/b1.log" })]),
    plan("run-b", "2026-10-05T10:00:00Z", "p.yaml", [job(1, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/b2.log" })]),
    plan("run-a", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/a.log" })]),
    plan("run-z", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/z.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  // The two batch entries share run id run-b: together they occupy ONE generation slot, so the
  // previous run (a.log) is still retained and only run-z leaves the window.
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/b1.log"), false);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/b2.log"), false);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/a.log"), false);
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/z.log"), true);
});

test("no silent truncation: more than sixty-four stale generations are all reported", () => {
  const plans = [];
  for (let i = 0; i < 100; i++)
    plans.push(plan(`run-${String(i).padStart(8, "0")}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z${i}`, "p.yaml",
      [job(0, 0, "failed", { logPath: `simple_cluster/tmp/tmux_logs/c${i}.log` })]));
  // Distinct enqueuedAt per plan so ordering is deterministic.
  plans.forEach((row, i) => { row.enqueuedAt = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 4), i % 4)).toISOString(); });
  const index = PluginLogRetention.retentionIndex(queueOf(plans));
  assert.equal(index.rows.length, 98);
});

test("shared scheduler log is reference-counted across generations and plans", () => {
  const queue = queueOf([
    plan("plan-live", "2026-10-04T10:00:00Z", "plans/shared.yaml", [job(0, 0, "running")]),
    plan("plan-old-1", "2026-10-01T10:00:00Z", "plans/shared.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/oldA.log" })]),
    plan("plan-old-2", "2026-10-02T10:00:00Z", "plans/shared.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/oldB.log" })]),
    plan("plan-old-3", "2026-10-03T10:00:00Z", "plans/shared.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/oldC.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  const shared = "simple_cluster/tmp/cluster_scheduler/plans_shared.yaml.log";
  // The per-plan scheduler log is shared with the still-running plan: never proposed.
  assert.equal(indexPath(index).includes(shared), false);
  // The per-generation job logs beyond the window are still proposed.
  assert.equal(indexPath(index).includes("simple_cluster/tmp/tmux_logs/oldA.log"), true);
});

test("matching is exact-path, not substring, and directory-scoped", () => {
  const queue = queueOf([
    plan("r1", "2026-10-01T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/command-abcdef12.log" })]),
    plan("r2", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/command-99.log" })]),
    plan("r3", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/command-98.log" })]),
    plan("r4", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/command-97.log" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  assert.ok(PluginLogRetention.isStaleRetentionRow(index, "simple_cluster/tmp/tmux_logs/COMMAND-ABCDEF12.log"));
  // A longer or different basename is a DIFFERENT file: exact-path matching must not claim it.
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, "simple_cluster/tmp/tmux_logs/command-abcdef12-extra.log"), undefined);
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, "simple_cluster/tmp/tmux_logs/xcommand-abcdef12.log"), undefined);
  // Outside the managed prefixes (result dirs, output dirs) is never retention-managed.
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, "experiments/results/command-abcdef12.csv"), undefined);
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, "simple_cluster/tmp/other/command-abcdef12.log"), undefined);
  // Case-insensitive matching honours the Windows workspace by default.
  assert.equal(PluginLogRetention.retentionIndex(queue, { caseInsensitive: false }).byPath.has("simple_cluster/tmp/tmux_logs/COMMAND-ABCDEF12.log"), false);
});

test("console filenames cannot authorize deletion without an exact persisted path", () => {
  const queue = queueOf([
    plan("c1", "2026-10-01T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-old" })]),
    plan("c2", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-b" })]),
    plan("c3", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-c" })]),
    plan("c4", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 0, "running", { tmuxSession: "sess-live" })]),
  ]);
  const index = PluginLogRetention.retentionIndex(queue);
  const name = session => `simple_cluster/console_logs/p/exp-0__case-c__seed-1__worker-w__gpu-0__status-done__session-${session}.log`;
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, name("sess-old")), undefined);
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, name("sess-b")), undefined);
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, name("sess-c")), undefined);
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, name("sess-live")), undefined);
  // Unknown session ownership is never proposed (conservative).
  assert.equal(PluginLogRetention.isStaleRetentionRow(index, name("sess-unknown")), undefined);
  // Protected session wins even if the same session string appears in a stale row elsewhere.
  const both = PluginLogRetention.retentionIndex(queueOf([
    plan("d1", "2026-10-01T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-dup" })]),
    plan("d2", "2026-10-02T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-x" })]),
    plan("d3", "2026-10-03T10:00:00Z", "p.yaml", [job(0, 0, "completed", { tmuxSession: "sess-y" })]),
    plan("d4", "2026-10-04T10:00:00Z", "p.yaml", [job(0, 0, "running", { tmuxSession: "sess-dup" })]),
  ]));
  assert.equal(PluginLogRetention.isStaleRetentionRow(both, name("sess-dup")), undefined);
});

test("admission preview virtual-joins the incoming generation and holds until deletion is verified", async () => {
  const queue = queueOf([
    plan("t1", "2026-10-01T10:00:00Z", "plans/a.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/genA.log", workerId: "node-a" })]),
    plan("t2", "2026-10-02T10:00:00Z", "plans/a.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/genB.log", workerId: "node-b" })]),
    plan("t3", "2026-10-03T10:00:00Z", "plans/a.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/genC.log", workerId: "node-b" })]),
    plan("t4", "2026-10-04T10:00:00Z", "plans/a.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/genD.log", workerId: "node-c" })]),
  ]);
  // Batched observation per leaving generation: the callback receives the exact paths AND the
  // persisted dispatch facts (workers) so the caller can stat them on the right machine.
  const observed = [];
  const outcome = state => async (paths, context) => {
    observed.push({ paths, workers: context.workers.slice().sort() });
    return new Map(paths.map(row => [row, state]));
  };
  // Virtual join: retained window becomes {incoming, t4}; t1–t3 leave the window and must be gone.
  const blocked = await PluginLogRetention.admissionPreview(queue, "plans/a.yaml", { observe: outcome("present") });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.pending.length >= 1, true);
  assert.match(blocked.pending[0].taskKey, /plans\/a\.yaml/);
  assert.equal(blocked.pending.some(row => row.reason === "old-generation-still-present"), true);
  // The retained newest generation sits next to the incoming one: its own log is never a leaving path.
  assert.equal(blocked.pending.every(row => !row.paths.includes("simple_cluster/tmp/tmux_logs/genD.log")), true);
  // Every leaving generation's observation carries the worker ids that physically ran it.
  assert.equal(observed.length >= 3, true);
  assert.equal(observed.every(row => row.workers.length >= 1), true);
  assert.equal(observed.some(row => row.workers.includes("node-a")), true);
  // Landing is allowed only once every leaving path is ACTIVELY VERIFIED absent (confirmed cleanup).
  const cleared = await PluginLogRetention.admissionPreview(queue, "plans/a.yaml", { observe: outcome("absent") });
  assert.equal(cleared.allowed, true);
  assert.equal(Array.isArray(cleared.taskKeys) && cleared.taskKeys.length >= 1, true);
  // A failed existence check is never treated as "absent" (fail-closed).
  const errored = await PluginLogRetention.admissionPreview(queue, "plans/a.yaml", { observe: outcome("error") });
  assert.equal(errored.allowed, false);
  assert.equal(errored.pending.some(row => row.reason === "existence-check-failed"), true);
  // A path the observation batch never answered is ALSO a failed check, never "absent".
  const silent = await PluginLogRetention.admissionPreview(queue, "plans/a.yaml", { observe: async () => new Map() });
  assert.equal(silent.allowed, false);
  assert.equal(silent.pending.some(row => row.reason === "existence-check-failed"), true);
  // Active or unknown old generations hold admission even when every file is verified absent.
  const activeQueue = queueOf([
    plan("a1", "2026-10-01T10:00:00Z", "plans/a.yaml", [job(0, 0, "running", { logPath: "simple_cluster/tmp/tmux_logs/live.log" })]),
    plan("a2", "2026-10-04T10:00:00Z", "plans/a.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/new.log" })]),
  ]);
  const held = await PluginLogRetention.admissionPreview(activeQueue, "plans/a.yaml", { observe: outcome("absent") });
  assert.equal(held.allowed, false);
  assert.equal(held.pending.some(row => row.reason === "old-generation-active"), true);
  // Independent plan files never hold each other's admission.
  const other = await PluginLogRetention.admissionPreview(queue, "plans/other.yaml", { observe: outcome("present") });
  assert.equal(other.allowed, true);
});

test("preflight wires the preview early and the fenced claim last", () => {
  const legacy = readSource("src/extension/legacy.ts");
  // Wiring smoke only — behaviour is proven by the claim-fence test below.
  assert.match(legacy, /await this\.assertRetentionWindow\?\.\(planKey, failPreflight\);\s*\n\s*let check = "校验\(validate-plan\)";/);
  assert.match(legacy, /await this\.claimRetentionWindow\?\.\(planKey, body, failPreflight, authority\);\s*\n\s*return previewed \? validated : false;/);
  const start = legacy.indexOf("async evaluateRetentionWindow(planKey)");
  const end = legacy.indexOf("async runActionCommandCore(", start);
  assert.ok(start > 0 && end > start, "retention methods must live outside the runActionCommandCore→runPlanPreflight fixture span");
});

test("fenced retention claim: host lease, stable id, same-flow reuse, foreign host nonce blocks, verified-absent gate", async () => {
  const legacy = readSource("src/extension/legacy.ts");
  const helpersStart = legacy.indexOf("const RETENTION_ADMISSION_LEAF");
  const helpersEnd = legacy.indexOf("function workspaceWriteStatusText", helpersStart);
  const methodsStart = legacy.indexOf("async evaluateRetentionWindow(planKey)");
  const methodsEnd = legacy.indexOf("async runActionCommandCore(", methodsStart);
  assert.ok(helpersStart > 0 && helpersEnd > helpersStart && methodsStart > 0 && methodsEnd > methodsStart);
  const transpile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const moduleCode = transpile(legacy.slice(helpersStart, helpersEnd));
  const classCode = transpile("class RetentionHost {\n" + legacy.slice(methodsStart, methodsEnd) + "\n}");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-claim-fence-"));
  const claimsPath = path.join(root, "simple_cluster/.simple-retention-admission.json");
  const processStub = { platform: "linux", pid: process.pid, kill: (pid, signal) => process.kill(pid, signal) };
  // The production fence runs inside the plugin's cross-process operation lease. The stub models
  // that EXCLUSION with one shared mutex across both hosts: contention must then be decided by
  // the persisted claims facts, and lease.assertHeld must be re-proven right before publishing.
  let gate = Promise.resolve();
  const leaseCalls = { asserts: 0 };
  const makeLeaseManager = () => ({
    acquire: async () => {
      const waiting = gate;
      let releaseGate;
      gate = new Promise(resolve => { releaseGate = resolve; });
      await waiting;
      return { assertHeld: async () => { leaseCalls.asserts += 1; }, release: async () => releaseGate() };
    },
  });
  const makeContext = nonce => {
    let uuidCount = 0;
    const sandbox = { fs: fsp, path, PluginLogRetention, process: processStub, workspaceRoot: () => root,
      uniqueStrings: rows => [...new Set(rows)],
      atomicWriteText: async (file, text) => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${crypto.randomUUID()}`;
        await fsp.writeFile(tmp, text, "utf8");
        await fsp.rename(tmp, file);
      },
      crypto: { createHash: crypto.createHash.bind(crypto), randomUUID: () => `${nonce}-${++uuidCount}` } };
    vm.createContext(sandbox);
    vm.runInContext(moduleCode + "\n" + classCode + "\nthis.nonce = EXTENSION_HOST_BOOT_NONCE;\nthis.Host = RetentionHost;\nthis.newSet = () => new Set();\nthis.readClaims = () => readRetentionClaims(workspaceRoot());\nthis.releaseClaim = (incoming, manager) => releaseRetentionClaim(workspaceRoot(), incoming, manager);", sandbox);
    return sandbox;
  };
  const hostA = makeContext("aaaaaaaa-1111");
  const hostB = makeContext("bbbbbbbb-2222");
  const failPreflight = (check, message, detail) => Object.assign(new Error(`${check}:${message}|${detail}`), { planPreflightReported: true });
  const makeHost = (ctx, queue, options = {}) => {
    // activeRetentionClaims must be created INSIDE the vm realm: the fence checks instanceof Set.
    const host = new ctx.Host();
    host.loadPlanOutputRetentionQueue = async () => queue;
    host.activeRetentionClaims = ctx.newSet();
    host.retentionBlockedWindows = new Map();
    host.hostOperationLease = options.leaseManager || makeLeaseManager();
    const seenWorkers = options.seenWorkers || [];
    host.observeRetentionPaths = options.observeWorker || (async (workerId, paths) => {
      seenWorkers.push(workerId);
      return { status: "completed", observations: paths.map(row => ({ path: row, state: fs.existsSync(path.join(root, row)) ? "present" : "absent" })) };
    });
    host.seenWorkers = seenWorkers;
    return host;
  };
  const empty = queueOf([]);
  // Stable submission id: the first preflight stamps it, the second (validate→execute) reuses ONE claim.
  const host1 = makeHost(hostA, empty);
  const body1 = { planFile: "plans/a.yaml" };
  await host1.claimRetentionWindow("plans/a.yaml", body1, failPreflight);
  assert.match(String(body1.retentionSubmissionId), /^retention-/);
  let claims = await hostA.readClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].incomingRun, body1.retentionSubmissionId);
  assert.equal(claims[0].hostNonce, hostA.nonce);
  assert.equal(claims[0].pid, process.pid);
  // A recovered identifier never authorizes a different host window to release its owner.
  await hostB.releaseClaim(body1.retentionSubmissionId, makeLeaseManager());
  assert.equal((await hostA.readClaims()).length, 1);
  // Claims carry deterministic facts only: no whole-queue digest (unrelated queue edits must not
  // silently free a live reservation) and the lease WAS re-proved right before the claim write.
  assert.equal(Array.isArray(claims[0].taskKeys), true);
  assert.equal("queueIdentity" in claims[0], false);
  assert.equal(leaseCalls.asserts >= 1, true);
  await makeHost(hostA, empty).claimRetentionWindow("plans/a.yaml", body1, failPreflight);
  claims = await hostA.readClaims();
  assert.equal(claims.length, 1);
  // Same pid, different extension-host window (boot nonce) blocks — no pid-based bypass.
  await assert.rejects(makeHost(hostB, empty).claimRetentionWindow("plans/a.yaml", { planFile: "plans/a.yaml", commandId: "cmd-b" }, failPreflight),
    error => error.planPreflightReported === true && /另一扩展主机实例/.test(error.message));
  claims = await hostA.readClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].incomingRun, body1.retentionSubmissionId);
  // Same host while the owning submission is STILL in flight (id in the in-flight set) → held.
  const busyHost = makeHost(hostA, empty);
  busyHost.activeRetentionClaims.add(body1.retentionSubmissionId);
  await assert.rejects(busyHost.claimRetentionWindow("plans/a.yaml", { planFile: "plans/a.yaml", commandId: "cmd-busy" }, failPreflight),
    error => error.planPreflightReported === true && /正在进行中的提交/.test(error.message));
  // Once the owning flow has terminated (id no longer in the in-flight set), the same host supersedes.
  host1.activeRetentionClaims.delete(body1.retentionSubmissionId);
  const body2 = { planFile: "plans/a.yaml" };
  await makeHost(hostA, empty).claimRetentionWindow("plans/a.yaml", body2, failPreflight);
  claims = await hostA.readClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].incomingRun, body2.retentionSubmissionId);
  // Verified-absent gate via WORKER OBSERVATION (a local stat proves nothing about remote logs):
  // observed present → held AND the blocked window is recorded for the cleanup review; observed
  // absent → allowed and the blocked record clears.
  const twoGens = queueOf([
    plan("g1", "2026-10-01T10:00:00Z", "plans/b.yaml", [job(0, 0, "failed", { logPath: "simple_cluster/tmp/tmux_logs/leaving.log", workerId: "node-w" })]),
    plan("g2", "2026-10-02T10:00:00Z", "plans/b.yaml", [job(0, 0, "completed", { logPath: "simple_cluster/tmp/tmux_logs/kept.log", workerId: "node-w" })]),
  ]);
  await fsp.mkdir(path.join(root, "simple_cluster/tmp/tmux_logs"), { recursive: true });
  await fsp.writeFile(path.join(root, "simple_cluster/tmp/tmux_logs/leaving.log"), "old");
  const heldHost = makeHost(hostA, twoGens);
  await assert.rejects(heldHost.claimRetentionWindow("plans/b.yaml", { planFile: "plans/b.yaml", commandId: "cmd-c" }, failPreflight),
    error => error.planPreflightReported === true && /old-generation-still-present/.test(error.message));
  assert.deepEqual(heldHost.seenWorkers, ["node-w"]);
  const blockedRows = hostA.Host && heldHost.retentionBlockedWindows.get("plans/b.yaml");
  assert.equal(Array.isArray(blockedRows) && blockedRows.some(row => row.path === "simple_cluster/tmp/tmux_logs/leaving.log"
    && row.reason === "old-generation-still-present" && row.workers.includes("node-w")), true);
  // A transport failure in the observation is a FAILED check, resolved as "still present", absent never.
  await assert.rejects(makeHost(hostA, twoGens, {
    observeWorker: async () => { throw new Error("tunnel down"); },
  }).claimRetentionWindow("plans/b.yaml", { planFile: "plans/b.yaml", commandId: "cmd-c2" }, failPreflight),
  error => error.planPreflightReported === true && /存在性核对失败/.test(error.message));
  await fsp.rm(path.join(root, "simple_cluster/tmp/tmux_logs/leaving.log"));
  const allowedHost = makeHost(hostA, twoGens);
  await allowedHost.claimRetentionWindow("plans/b.yaml", { planFile: "plans/b.yaml", commandId: "cmd-d" }, failPreflight);
  assert.equal(allowedHost.retentionBlockedWindows.has("plans/b.yaml"), false);
  // A lease lost while previewing can NEVER publish a claim: assertHeld throws and the store is untouched.
  const lostLeaseHost = makeHost(hostA, empty, {
    leaseManager: { acquire: async () => ({ assertHeld: async () => { throw new Error("租约已失效"); }, release: async () => undefined }) },
  });
  await assert.rejects(lostLeaseHost.claimRetentionWindow("plans/e.yaml", { planFile: "plans/e.yaml", commandId: "cmd-lost" }, failPreflight),
    /租约已失效/);
  claims = await hostA.readClaims();
  assert.equal(claims.some(row => row.planFile === "plans/e.yaml"), false);
  // Damaged claims fail CLOSED (admission refuses) and the record is preserved byte-exact.
  const intact = fs.readFileSync(claimsPath, "utf8");
  await fsp.writeFile(claimsPath, "{not-json");
  await assert.rejects(makeHost(hostA, empty).claimRetentionWindow("plans/f.yaml", { planFile: "plans/f.yaml" }, failPreflight),
    error => error.retentionClaimsUnreadable === true);
  await assert.rejects(hostA.readClaims(), error => error.retentionClaimsUnreadable === true);
  await fsp.writeFile(claimsPath, JSON.stringify({ schemaVersion: 2, claims: [{ planFile: 7 }] }));
  await assert.rejects(makeHost(hostA, empty).claimRetentionWindow("plans/f.yaml", { planFile: "plans/f.yaml" }, failPreflight),
    error => error.retentionClaimsUnreadable === true);
  assert.equal(fs.readFileSync(claimsPath, "utf8"), JSON.stringify({ schemaVersion: 2, claims: [{ planFile: 7 }] }));
  await fsp.writeFile(claimsPath, intact);
  // Concurrent submissions for one plan: the lease+claim fence lets exactly one through.
  const raced = await Promise.allSettled([
    makeHost(hostA, empty).claimRetentionWindow("plans/c.yaml", { planFile: "plans/c.yaml", commandId: "cmd-e" }, failPreflight),
    makeHost(hostB, empty).claimRetentionWindow("plans/c.yaml", { planFile: "plans/c.yaml", commandId: "cmd-f" }, failPreflight),
  ]);
  assert.equal(raced.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(raced.filter(row => row.status === "rejected").length, 1);
  // A host without the persisted queue store evaluates no retention gate and never blocks.
  const bare = new hostA.Host();
  await bare.claimRetentionWindow("plans/a.yaml", {}, failPreflight);
  await bare.assertRetentionWindow("plans/a.yaml", failPreflight);
});

test("workspace backups keep exactly one history generation and refuse a third with zero new files", async () => {
  const extension = readSource("src/extension/legacy.ts");
  const start = extension.indexOf("async function writeWorkspaceTextWithBackup");
  const slotStart = extension.indexOf("async function nextWorkspaceBackupSlot", start);
  const end = extension.indexOf("const RETENTION_ADMISSION_LEAF", slotStart);
  assert.ok(start > 0 && slotStart > start && end > slotStart);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-backup-rotation-"));
  const target = path.join(root, "experiments", "plans", "a.yaml");
  const sandbox = {
    workspaceRoot: () => root,
    fs: fsp,
    path,
    crypto,
    process: { platform: "linux" },
    atomicWriteText: async (file, text) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text, "utf8"); },
  };
  vm.createContext(sandbox);
  const region = extension.slice(start, slotStart) + "\n" + extension.slice(slotStart, end);
  const code = ts.transpileModule(region, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(code + "\nthis.api = { writeWorkspaceTextWithBackup };", sandbox);
  const writer = sandbox.api.writeWorkspaceTextWithBackup;
  const backups = path.join(root, "simple_cluster", "tmp", "backups");
  const first = await writer(target, "v1");
  assert.equal(first.status, "created");
  assert.equal(first.backupPath, undefined);
  // Second generation: the ORIGINAL becomes the single history copy in the fixed slot.
  await writer(target, "v2");
  const keys = fs.readdirSync(backups);
  assert.equal(keys.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(backups, keys[0])), ["a.yaml.bak"]);
  assert.equal(fs.readFileSync(path.join(backups, keys[0], "a.yaml.bak"), "utf8"), "v1");
  // Identical re-save is "unchanged" and consumes NOTHING: no backup churn for no-op saves.
  const again = await writer(target, "v2");
  assert.equal(again.status, "unchanged");
  assert.equal(fs.readFileSync(path.join(backups, keys[0], "a.yaml.bak"), "utf8"), "v1");
  // Third generation while the history slot is occupied: the exiting copy has NOT passed the
  // confirmed cleanup review, so the write is REFUSED and zero files change (no overwrite of
  // the previous copy, no unbounded timestamped slots, no third copy anywhere).
  const before = { source: fs.readFileSync(target, "utf8"), backup: fs.readFileSync(path.join(backups, keys[0], "a.yaml.bak"), "utf8") };
  await assert.rejects(writer(target, "v3"), /尚未经缓存清理审核确认删除/);
  assert.equal(fs.readFileSync(target, "utf8"), before.source);
  assert.equal(fs.readFileSync(path.join(backups, keys[0], "a.yaml.bak"), "utf8"), before.backup);
  assert.deepEqual(fs.readdirSync(path.join(backups, keys[0])), ["a.yaml.bak"]);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["a.yaml"]);
  // Only the confirmed cleanup executor vacates the slot; the next write then rotates cleanly.
  await fsp.rm(path.join(backups, keys[0], "a.yaml.bak"));
  await writer(target, "v3");
  assert.deepEqual(fs.readdirSync(path.join(backups, keys[0])), ["a.yaml.bak"]);
  assert.equal(fs.readFileSync(path.join(backups, keys[0], "a.yaml.bak"), "utf8"), "v2");
  assert.equal(fs.readFileSync(target, "utf8"), "v3");
  // No .bak chain may ever appear next to the source file.
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["a.yaml"]);
});

test("download slots use one deterministic incoming and never land a third generation", async () => {
  const extension = readSource("src/extension/legacy.ts");
  const start = extension.indexOf("function pluginCopySlotPaths");
  const end = extension.indexOf("function remoteResultInspectionLocalRelativePath", start);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-copy-slot-"));
  const slot = path.join(root, "latest.zip");
  const sandbox = { fs: fsp, path, process };
  vm.createContext(sandbox);
  const code = ts.transpileModule(extension.slice(start, end),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(code + "\nthis.api = { pluginCopySlotPaths, pluginCopyIncomingRelative, admitPluginCopySlot, publishPluginCopySlot, withPluginCopySlotLock };", sandbox);
  const api = sandbox.api, lease = { assertHeld: async () => undefined };
  const incoming = path.join(root, "latest.incoming.zip");
  assert.equal(api.pluginCopyIncomingRelative("simple_cluster/tmp/downloads/latest.zip"),
    "simple_cluster/tmp/downloads/latest.incoming.zip");
  await api.admitPluginCopySlot(slot);
  await fsp.writeFile(incoming, "gen1");
  await api.publishPluginCopySlot(incoming, slot, lease);
  assert.equal(fs.readFileSync(slot, "utf8"), "gen1");
  assert.equal(fs.existsSync(incoming), false);
  await api.admitPluginCopySlot(slot);
  await fsp.writeFile(incoming, "gen2");
  await api.publishPluginCopySlot(incoming, slot, lease);
  assert.deepEqual(fs.readdirSync(root).sort(), ["latest.prev.zip", "latest.zip"]);
  assert.equal(fs.readFileSync(slot, "utf8"), "gen2");
  assert.equal(fs.readFileSync(path.join(root, "latest.prev.zip"), "utf8"), "gen1");
  const before = fs.readdirSync(root).sort();
  await assert.rejects(api.admitPluginCopySlot(slot), /两代保留已满/);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  // A failed second run occupies the ONE deterministic incoming slot. Every retry stays held;
  // no per-pid/nonce file, unlink or sixth-file allowance can create additional generations.
  const failed = path.join(root, "failed.zip"), partial = path.join(root, "failed.incoming.zip");
  await fsp.writeFile(failed, "retained");
  await fsp.writeFile(partial, "interrupted");
  await assert.rejects(api.admitPluginCopySlot(failed), /两代保留已满/);
  assert.equal(fs.readFileSync(partial, "utf8"), "interrupted");
  await assert.rejects(api.publishPluginCopySlot(partial, failed,
    { assertHeld: async () => { throw new Error("lost"); } }), /lost/);
  assert.equal(fs.readFileSync(failed, "utf8"), "retained");
  assert.equal(fs.readFileSync(partial, "utf8"), "interrupted");
  await assert.rejects(api.withPluginCopySlotLock(slot, async () => undefined), /跨窗口租约/);
});

test("inspection download slots are deterministic per stable remote source", () => {
  const extension = readSource("src/extension/legacy.ts");
  const start = extension.indexOf("function remoteResultInspectionLocalRelativePath");
  const end = extension.indexOf("function methodResultArtifactLocalRelativePath", start);
  assert.ok(start > 0 && end > start);
  const code = ts.transpileModule(extension.slice(extension.indexOf("function normalizeRemoteResultInspectionPath"), end),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  // Mac 契约：结果路径按 process.platform 走 POSIX 规范化分支，沙箱必须提供 process.platform。
  const sandbox = { path, crypto, process: { platform: process.platform }, FileTransferTypes_1: { isSafeRemotePath: value => !value.includes("..") },
    WrapperResultBundle: { isWrapperResultFile: () => true }, safePlanToken: value => String(value).replace(/[^a-z0-9]/gi, "_") };
  vm.createContext(sandbox);
  vm.runInContext(code + "\nthis.api = { remoteResultInspectionLocalRelativePath };", sandbox);
  const first = sandbox.api.remoteResultInspectionLocalRelativePath("results/run1/metrics.csv", "plans/a.yaml");
  const second = sandbox.api.remoteResultInspectionLocalRelativePath("results/run1/metrics.csv", "plans/a.yaml");
  assert.equal(first, second);
  assert.match(first, /^simple_cluster\/tmp\/downloads\/result_inspection\//);
});
