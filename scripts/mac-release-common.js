"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { npmCommand } = require("./npm-command");
const EXPERIMENT_ROOT = path.resolve(__dirname, "..");
const SFTP_ROOT = path.resolve(process.env.SIMPLE_SFTP_MAC_SOURCE || path.join(EXPERIMENT_ROOT, "../SimpleSFTP-Mac"));
const REPOSITORY = "zlinkw/SimpleExperiment-Mac";

function run(command, args, cwd = EXPERIMENT_ROOT, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: options.binary ? undefined : "utf8", windowsHide: true, timeout: options.timeout || 30000, maxBuffer: 128 * 1024 * 1024, stdio: options.inherit ? "inherit" : "pipe" });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}): ${result.error?.message || String(result.stderr || result.stdout || "").slice(-4000)}`);
  return options.binary ? result.stdout : String(result.stdout || "").trim();
}
function npm(args, cwd) { const invocation = npmCommand(args); run(invocation.command, invocation.args, cwd, { inherit: true, timeout: 120000 }); }
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function fingerprint(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) throw new Error("Release artifact identity is unsafe");
  const bytes = fs.readFileSync(file); return { name: path.basename(file), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function assertSource(root, repo) {
  if (run("git", ["branch", "--show-current"], root) !== "master" || run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root) !== "origin/master") throw new Error("Release requires master tracking origin/master");
  const remote = run("git", ["remote", "get-url", "origin"], root);
  if (![ `https://github.com/zlinkw/${repo}.git`, `https://github.com/zlinkw/${repo}`, `git@github.com:zlinkw/${repo}.git` ].includes(remote)) throw new Error("Unexpected release source origin");
  if (run("git", ["status", "--porcelain"], root)) throw new Error("Release source contains uncommitted or unreviewed files");
  if (run("git", ["ls-files", ".github/workflows/*"], root)) throw new Error("Mac release source must not contain Actions workflows");
  run("git", ["fetch", "origin"], root);
  const commit = run("git", ["rev-parse", "HEAD"], root);
  if (commit !== run("git", ["rev-parse", "origin/master"], root)) throw new Error("Source HEAD differs from origin/master; stop without merge or rebase");
  return commit;
}
function verifyRemoteAssets(expected, actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error("Draft does not contain exactly the complete asset set");
  for (const item of expected) {
    const assets = actual.filter(asset => asset.name === item.name);
    if (assets.length !== 1 || assets[0].state !== "uploaded" || assets[0].size !== item.size || assets[0].digest !== `sha256:${item.sha256}`) throw new Error(`Remote asset verification failed: ${item.name}`);
  }
}
function assertNewerPreview(tag, releases) {
  const semver = require("semver");
  const version = /^preview-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!semver.valid(version)) throw new Error("Invalid preview version");
  for (const release of releases) {
    if (release.draft) continue;
    const previous = /^preview-v(\d+\.\d+\.\d+)$/.exec(release.tag_name || "")?.[1];
    if (semver.valid(previous) && semver.compare(version, previous) <= 0) throw new Error("Preview fixes require a higher version than every published preview");
  }
}
module.exports = { EXPERIMENT_ROOT, SFTP_ROOT, REPOSITORY, run, npm, json, fingerprint, assertSource, verifyRemoteAssets, assertNewerPreview };
