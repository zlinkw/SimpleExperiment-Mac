const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Driver for gpuCollectorFrame.fixture.py, following the existing WSL/POSIX
// fixture convention (formalIdentityTmux.test.js): extracted production
// functions only (never the module entry point), one spawn <=10s, windowsHide,
// real exit-code assertion, fixtures KEPT on disk with the path reported.
const FIXTURE = path.join(__dirname, "gpuCollectorFrame.fixture.py");

function toMountedPath(target) {
  return target.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
}
function runCase(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-collector-frame-"));
  const target = process.platform === "win32" ? toMountedPath(root) : root;
  const args = process.platform === "win32"
    ? ["--distribution", process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex", "--exec", "/usr/bin/python3",
       "-B", toMountedPath(FIXTURE), mode, target]
    : ["-B", FIXTURE, mode, target];
  const proc = spawnSync(process.platform === "win32" ? "wsl.exe" : "python3", args,
    { cwd: path.join(__dirname, "../.."), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.ok(!proc.error, `spawn failed (fixture kept at ${root}): ${proc.error && proc.error.message}`);
  assert.equal(proc.status, 0, `mode ${mode} exited ${proc.status} (fixture kept at ${root})\n${proc.stdout}\n${proc.stderr}`);
  const lines = String(proc.stdout).trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("single-source identity: worker-only session, authoritative state root, zero-config managed anchor", () => {
  const report = runCase("identity");
  assert.equal(report.ok, true);
  assert.match(report.detail.session, /^se-gpu-collector-[0-9a-f]{16}$/);
  assert.match(report.detail.anchor, /\.simple-cluster\/worker-state$/);
});

test("frame reads: generation consistency, ENOTDIR/oversize unreadable, unregistered/stalled modes, real permission semantics", () => {
  const report = runCase("reads");
  assert.equal(report.ok, true);
  assert.ok(["enforced-and-verified", "mount-does-not-enforce-000", "chmod-unavailable"]
    .includes(report.detail.permissionSemantics), report.detail);
});

test("machine writer lock rejects a second collector before publishing or sampling", () => {
  const report = runCase("writer_lock");
  assert.equal(report.detail.samplerCalls, 0);
});

test("gpu_collector_main really loops and publishes its own generation", () => {
  const report = runCase("main_loop");
  assert.equal(report.ok, true);
  assert.ok(Number(report.detail.seq) >= 2 && report.detail.epoch, report.detail);
});

test("admission rejects a sample that started BEFORE the request even when seq advanced", () => {
  const report = runCase("causality");
  assert.equal(report.ok, true);
  assert.equal(report.detail.accepted, 12);
});

test("generation authority: mid-request restart is followed, old epochs never flood back", () => {
  const report = runCase("generation");
  assert.equal(report.ok, true);
  assert.equal(report.detail.followed, "gen-2");
});

test("evidence binds command/root/gpus with no defaults; every tamper fails closed", () => {
  const report = runCase("evidence");
  assert.equal(report.ok, true);
  for (const field of ["commandId", "fingerprint", "gpuIds", "root", "workerId"]) {
    assert.ok(report.detail.fields.includes(field), field);
  }
});

test("collector-capable runtime never infers legacy from absent files; broken states never resample", () => {
  const report = runCase("capability");
  assert.equal(report.ok, true);
  assert.equal(report.detail.samplerCalls, 0);
});

test("ensure verifies exact identity in every branch; respawn is a single-writer transaction", () => {
  const report = runCase("ensure");
  assert.equal(report.ok, true);
});

test("inventory carries fresh frames lock-free and reports broken shared states honestly", () => {
  const report = runCase("inventory");
  assert.deepEqual(report.detail.states, ["ready", "stale", "unregistered", "stalled"]);
});

test("concurrent consumers only ever see whole frames with per-reader monotonic seq", () => {
  const report = runCase("concurrency");
  assert.equal(report.ok, true);
  assert.ok(Number(report.detail.reads) > 10, report.detail.reads);
});
