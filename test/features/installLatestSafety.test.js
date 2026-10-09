const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const installScript = require("../../scripts/install-latest");
const { runInstallLatest, parseInstalledVersion, compareVersions } = require("../../scripts/install-latest-policy");

function testLock(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-install-test-"));
  // Isolated evidence is retained; no recursive deletion during tests.
  return path.join(directory, "install.lock");
}

test("same installed version skips without invoking the installer", async (t) => {
  const calls = [];
  const outcome = await runInstallLatest({
    targetVersion: "0.5.194", extensionId: "simple-local.simple-experiment",
    lockPath: testLock(t),
    listExtensions: async () => "simple-local.simple-experiment@0.5.194\n",
    install: async (...args) => calls.push(args),
  });
  assert.deepEqual(outcome, { status: "skip", version: "0.5.194" });
  assert.equal(calls.length, 0);
});

test("older installed version installs once without force and verifies the result", async (t) => {
  const calls = [];
  let listed = 0;
  const outcome = await runInstallLatest({
    targetVersion: "0.5.194", extensionId: "simple-local.simple-experiment", vsixPath: "extension.vsix",
    lockPath: testLock(t),
    listExtensions: async () => ++listed === 1 ? "simple-local.simple-experiment@0.5.193\n" : "simple-local.simple-experiment@0.5.194\n",
    install: async (...args) => calls.push(args),
  });
  assert.deepEqual(outcome, { status: "installed", version: "0.5.194" });
  assert.deepEqual(calls, [["extension.vsix"]]);
  assert.equal(JSON.stringify(calls).includes("--force"), false);
});

test("higher installed version blocks downgrade", async (t) => {
  let installs = 0;
  await assert.rejects(() => runInstallLatest({
    targetVersion: "0.5.193", extensionId: "simple-local.simple-experiment",
    lockPath: testLock(t),
    listExtensions: async () => "simple-local.simple-experiment@0.5.194\n",
    install: async () => installs++,
  }), /downgrade/i);
  assert.equal(installs, 0);
});

test("repeating an install sees the installed target and skips", async (t) => {
  let version = "0.5.193", installs = 0;
  const dependencies = {
    targetVersion: "0.5.194", extensionId: "simple-local.simple-experiment", vsixPath: "extension.vsix",
    lockPath: testLock(t),
    listExtensions: async () => `simple-local.simple-experiment@${version}\n`,
    install: async () => { installs++; version = "0.5.194"; },
  };
  assert.equal((await runInstallLatest(dependencies)).status, "installed");
  assert.equal((await runInstallLatest({ ...dependencies, lockPath: testLock(t) })).status, "skip");
  assert.equal(installs, 1);
});

test("package lifecycle has no automatic install hook", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.equal(packageJson.scripts.postpackage, undefined);
  assert.doesNotMatch(packageJson.scripts.package, /install-latest|install:latest/);
});

test("installed version parsing and comparison are semantic", () => {
  assert.equal(parseInstalledVersion("other.ext@1.2.3\nsimple-local.simple-experiment@0.5.194\n", "simple-local.simple-experiment"), "0.5.194");
  assert.equal(compareVersions("0.5.9", "0.5.10"), -1);
});

test("dry-run reports the decision without invoking the installer or creating a lock", async () => {
  let installs = 0;
  const outcome = await runInstallLatest({
    targetVersion: "0.5.195", extensionId: "simple-local.simple-experiment", vsixPath: "fixture.vsix", dryRun: true,
    listExtensions: async () => "simple-local.simple-experiment@0.5.194\n", install: async () => installs++,
  });
  assert.equal(outcome.status, "dry-run");
  assert.equal(outcome.decision, "upgrade");
  assert.equal(outcome.vsixPath, "fixture.vsix");
  assert.equal(installs, 0);
});

test("concurrent install processes are serialized by an atomic lock", async (t) => {
  const lockPath = testLock(t);
  let version = "0.5.193", installs = 0, releaseInstall, startedInstall;
  const pause = new Promise(resolve => { releaseInstall = resolve; });
  const started = new Promise(resolve => { startedInstall = resolve; });
  const shared = { targetVersion: "0.5.194", extensionId: "simple-local.simple-experiment", vsixPath: "fixture.vsix", lockPath,
    listExtensions: async () => `simple-local.simple-experiment@${version}\n`,
    install: async () => { installs++; startedInstall(); await pause; version = "0.5.194"; } };
  const first = runInstallLatest(shared);
  await started;
  await assert.rejects(() => runInstallLatest(shared), /holds the lock/);
  releaseInstall();
  assert.equal((await first).status, "installed");
  assert.equal(installs, 1);
});

test("an unheld fixed slot is reused without deletion or stale metadata blocking", async (t) => {
  const lockPath = testLock(t);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 992341, targetVersion: "0.5.194", startedAt: "fixture" }), "utf8");
  const original = fs.readFileSync(lockPath, "utf8");
  const result = await runInstallLatest({ targetVersion: "0.5.194", extensionId: "simple-local.simple-experiment", lockPath,
    listExtensions: async () => "simple-local.simple-experiment@0.5.194", install: async () => assert.fail("already installed") });
  assert.equal(result.status, "skip");
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), original);
});

test("requiring install-latest.js is inert and package does not run the installer", () => {
  assert.equal(typeof installScript.main, "function");
  assert.equal(require.main === installScript, false);
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.doesNotMatch(packageJson.scripts.package, /install:latest/);
  assert.match(packageJson.scripts["install:latest"], /install-latest\.js/);
});
