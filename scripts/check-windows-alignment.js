"use strict";
// Source checks only. Does not build, load extensions, run tests, connect or publish.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "windows-source-baseline.json"), "utf8"));
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const peer = path.resolve(option("--sftp-root") || path.join(root, "../SimpleSFTP-Mac"));
const digest = text => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
let checked = 0;
for (const component of manifest.components) {
  const directory = component.name === "experiment" ? root : peer;
  const donor = option(component.name === "experiment" ? "--windows-experiment-root" : "--windows-sftp-root");
  const snapshot = option(component.name === "experiment" ? "--windows-experiment-snapshot" : "--windows-sftp-snapshot");
  if (donor && snapshot) throw Error("Choose a Git donor or frozen source snapshot, not both");
  for (const row of component.files) {
    if (!row.path || row.path.includes("..") || path.isAbsolute(row.path)) throw Error("Unsafe manifest source path");
    const file = path.join(directory, row.path), text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
    if (digest(text) !== row.localSha256) throw Error(`Source drift: ${component.name}/${row.path}`);
    if (row.classification === "platform-overlay" && !row.reason) throw Error(`Unexplained platform overlay: ${row.path}`);
    if (donor && row.windowsSha256) {
      const result = spawnSync("git", ["show", component.windowsCommit + ":" + row.path], { cwd: donor, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0 || digest(result.stdout) !== row.windowsSha256) throw Error(`Windows baseline mismatch: ${component.name}/${row.path}`);
    }
    if (snapshot && row.windowsSha256) {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(snapshot, row.path)));
      if (digest(source) !== row.windowsSha256) throw Error(`Frozen snapshot mismatch: ${component.name}/${row.path}`);
    }
    checked++;
  }
}
process.stdout.write(JSON.stringify({ kind: "static-source-fingerprints", files: checked, pendingSourceGaps: manifest.sourceGaps?.length || 0, windowsCommits: manifest.components.map(c => c.windowsCommit), executedApplicationModules: 0, build: "not run", tests: "not run" }) + "\n");
