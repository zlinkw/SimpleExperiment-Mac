"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

function parseInstalledVersion(output, extensionId) {
  const prefix = `${extensionId.toLowerCase()}@`;
  const row = String(output || "").split(/\r?\n/).find((line) => line.trim().toLowerCase().startsWith(prefix));
  return row ? row.trim().slice(prefix.length) : "";
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) throw new Error(`Invalid extension version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split(".") : [] };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    if (a.prerelease[i] === b.prerelease[i]) continue;
    const an = /^\d+$/.test(a.prerelease[i]), bn = /^\d+$/.test(b.prerelease[i]);
    if (an && bn) return Number(a.prerelease[i]) < Number(b.prerelease[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a.prerelease[i] < b.prerelease[i] ? -1 : 1;
  }
  return 0;
}

async function acquireInstallLock({ lockPath }) {
  const win = process.platform === "win32";
  const args = win ? ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "install-latest-lock.ps1"), "-LockPath", lockPath]
    : ["-B", "-X", "utf8", path.join(__dirname, "install-latest-lock.py"), lockPath];
  const child = spawn(win ? "pwsh.exe" : "python3", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", output = "", closed = false;
  const exited = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-8192); });
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); finish(new Error("Install lock admission timed out")); }, 5000);
    const finish = error => {
      clearTimeout(timer); child.removeListener("error", onError); child.removeListener("close", onClose);
      child.stdout.removeListener("data", onData); error ? reject(error) : resolve();
    };
    const onError = error => finish(error);
    const onClose = () => finish(new Error(`Another install:latest process holds the lock or the lock target is unsafe: ${lockPath}\n${stderr}`));
    const onData = bytes => { output = (output + bytes.toString("utf8")).slice(-128); if (output.trim() === "LOCKED") finish(); };
    child.once("error", onError); child.once("close", onClose); child.stdout.on("data", onData);
  });
  let released = false;
  return async () => {
    if (released) return; released = true;
    if (!closed) child.stdin.end("release\n");
    const timer = setTimeout(() => child.kill(), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
}

async function runInstallLatest({ targetVersion, extensionId, vsixPath, listExtensions, install, dryRun = false, fsApi = require("node:fs/promises"), lockPath, pid = process.pid, isProcessAlive = (candidate) => { try { process.kill(candidate, 0); return true; } catch (error) { return error.code === "EPERM"; } } }) {
  const decide = async () => {
    const installedVersion = parseInstalledVersion(await listExtensions(), extensionId);
    if (installedVersion) {
      const comparison = compareVersions(installedVersion, targetVersion);
      if (comparison === 0) return { status: "skip", decision: "already-installed", version: targetVersion, installedVersion };
      if (comparison > 0) throw new Error(`Refusing to downgrade ${extensionId} from ${installedVersion} to ${targetVersion}.`);
    }
    return { status: "install", decision: installedVersion ? "upgrade" : "install", installedVersion };
  };
  if (dryRun) {
    const decision = await decide();
    return { ...decision, status: "dry-run", targetVersion, vsixPath };
  }
  if (!lockPath) throw new Error("An install lock path is required.");
  const release = await acquireInstallLock({ fsApi, lockPath, targetVersion, pid, isProcessAlive });
  try {
    const decision = await decide();
    if (decision.status === "skip") return { status: "skip", version: targetVersion };
    await install(vsixPath);
    const verifiedVersion = parseInstalledVersion(await listExtensions(), extensionId);
    if (verifiedVersion !== targetVersion) {
      throw new Error(`Install verification failed: expected ${extensionId}@${targetVersion}, found ${verifiedVersion || "not installed"}.`);
    }
    return { status: "installed", version: targetVersion };
  } finally {
    await release();
  }
}

module.exports = { acquireInstallLock, compareVersions, parseInstalledVersion, runInstallLatest };
