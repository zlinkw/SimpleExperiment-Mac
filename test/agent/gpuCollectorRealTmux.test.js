const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Real-tmux lifecycle evidence for the GPU collector, on the existing WSL/POSIX
// fixture convention (formalIdentityTmux.test.js) and the isolated-socket
// convention (formalIdentityTmux.fixture.py): the fixture extracts ONLY the
// tested production functions, every phase is a separate spawn (<=10s,
// windowsHide, status asserted), the private per-run tmux server on its own
// socket makes every other session unreachable, the dead-pane is produced by
// the collector's own natural process exit (no PID signals, no kill-session of
// anything), and teardown verifies and closes only recorded window IDs. Fixtures are
// KEPT on disk and their path printed.
const FIXTURE = path.join(__dirname, "gpuCollectorRealTmux.fixture.py");
const DIST = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
assert.ok(fs.existsSync(DIST), "generated runtime missing; run scripts/write-agent-runtime.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "se-gpu-tmux-"));
const STATE = path.join(ROOT, "evidence.json");
// The socket name is unique per run (derived from the unique temp dir), so all
// phases share ONE private server and no phase can reach a shared/foreign one.
const SOCKET = "se-gpuc-" + path.basename(ROOT).replace(/[^A-Za-z0-9_-]/g, "-");

function toMountedPath(target) {
  return target.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
}
function runPhase(mode) {
  const target = process.platform === "win32" ? toMountedPath(ROOT) : ROOT;
  const args = process.platform === "win32"
    ? ["--distribution", process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex", "--exec", "/usr/bin/python3",
       "-B", toMountedPath(FIXTURE), mode, target, toMountedPath(STATE), SOCKET]
    : ["-B", FIXTURE, mode, ROOT, STATE, SOCKET];
  const proc = spawnSync(process.platform === "win32" ? "wsl.exe" : "python3", args,
    { cwd: path.join(__dirname, "../.."), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.ok(!proc.error, `phase ${mode} spawn failed (fixture kept at ${ROOT}): ${proc.error && proc.error.message}`);
  assert.equal(proc.status, 0, `phase ${mode} exited ${proc.status} (fixture kept at ${ROOT})\n${proc.stdout}\n${proc.stderr}`);
  const lines = String(proc.stdout).trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

let phaseA = null;

test("real tmux: ensure starts the ONE canonical collector session and it publishes its own generation", () => {
  const report = runPhase("phase-a");
  assert.equal(report.ok, true);
  assert.equal(report.detail.ensure, "started");
  assert.match(report.detail.session, /^se-gpu-collector-[0-9a-f]{16}$/);
  assert.equal(report.detail.windows, 1, report.detail);
  assert.ok(report.detail.epoch && report.detail.epoch.includes("-"), report.detail);
  phaseA = report.detail;
});

test("real tmux: the consumer process exits, the SAME generation keeps advancing, ensure reports running", () => {
  assert.ok(phaseA, "phase A evidence missing");
  const report = runPhase("phase-b");
  assert.equal(report.ok, true);
  assert.ok(Number(report.detail.survivedSeq) > Number(report.detail.oldSeq),
    `seq did not advance across a real consumer exit: ${report.detail}`);
  assert.equal(report.detail.epoch, phaseA.epoch);
});

test("real tmux: a naturally-exited collector pane (own binding) respawns a NEW generation, never a second session", () => {
  const report = runPhase("phase-c");
  assert.equal(report.ok, true);
  assert.equal(report.detail.respawn, "respawned");
  assert.ok(report.detail.newEpoch && report.detail.newEpoch !== report.detail.oldEpoch, report.detail);
  assert.ok(Number(report.detail.newSeq) >= 1, report.detail);
});

test("real tmux: teardown verifies and closes only two recorded windows; fixtures kept", () => {
  const report = runPhase("phase-t");
  assert.equal(report.ok, true);
  assert.equal(report.detail.closedWindows.length, 2);
  assert.equal(report.detail.serverGone, true, report.detail);
  console.log("kept fixtures at " + ROOT + " (private socket " + SOCKET + ")");
});
