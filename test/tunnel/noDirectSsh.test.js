const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("active extension uses localhost clients and verified Xshell sessions instead of direct remote runners", () => {
  const extension = readSource("src/extension.ts");
  const launcher = fs.readFileSync(path.join(root, "src", "tunnel", "XshellSessionLauncher.ts"), "utf8");
  for (const item of ["RemoteExecutionService", "RuntimeService", "RemoteFileStore", "FakeRemoteCommandRunner", "runSsh(", "connectSshSessions", "closeControlMasterSessions"]) {
    assert.equal(extension.includes(item), false, item);
  }
  assert.doesNotMatch(extension, /(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](?:ssh|scp|rsync)["']/i);
  assert.match(extension, /spawnSync\("gh", \["--version"\]/);
  assert.match(extension, /launchXshellSavedSession/);
  assert.match(launcher, /path\.basename\(request\.exePath \|\| ""\)\.toLowerCase\(\) !== "xshell\.exe"/);
  assert.match(launcher, /spawn\(request\.exePath, \[request\.sessionPath\]/);
  assert.doesNotMatch(launcher, /spawn\(["'](?:ssh|scp|rsync)/i);
});

test("extension dist has no direct remote command fallback", () => {
  const text = fs.readFileSync(path.join(root, "dist", "extension", "legacy.js"), "utf8");
  for (const item of ["runSsh(", "connectSshSessions", "closeControlMasterSessions", "ControlMaster", "ControlPath"]) {
    assert.equal(text.includes(item), false, item);
  }
  assert.match(text, /xshell_tunnel_realtime/);
  assert.match(text, /XshellSessionLauncher/);
  assert.match(text, /127\.0\.0\.1/);
});

test("package UI does not expose direct fallback commands", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const commandIds = pkg.contributes.commands.map((item) => item.command);
  for (const forbidden of ["simpleExperiment.scanGpu", "simpleExperiment.deployRuntime", "simpleExperiment.verifyRuntime"]) {
    assert.equal(commandIds.includes(forbidden), false, forbidden);
  }
  assert.equal(commandIds.filter((id) => /Tunnel/i.test(id)).every((id) => !/configure.*RealtimeTunnel/i.test(id) || /Xshell/i.test(id)), true);
  assert.equal(commandIds.some((id) => /LegacySsh|legacySsh/i.test(id)), false);
});

test("extension command registration exposes only Xshell tunnel command ids", () => {
  // The Mac extension.ts is a facade; registration lives in the legacy activation module.
  const text = readSource("src/extension/legacy.ts");
  const registered = Array.from(text.matchAll(/(?:registerCommand|hostCommand)\("([^"]+)"/g)).map((match) => match[1]);
  assert.equal(registered.filter((id) => /Tunnel/i.test(id)).every((id) => !/configure.*RealtimeTunnel/i.test(id) || /Xshell/i.test(id)), true);
  assert.equal(registered.some((id) => /LegacySsh|legacySsh/i.test(id)), false);
  assert.equal(registered.includes("simpleExperimentMac.configureXshellSavedSessions"), true);
  assert.equal(registered.includes("simpleExperimentMac.startAllXshellRealtimeTunnels"), true);
});

test("only the sanctioned -N -L forwarder references the system ssh binary", () => {
  const sanctioned = path.join("src", "mac", "OpenSshTunnels.ts");
  const hits = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith(".ts") && fs.readFileSync(file, "utf8").includes("/usr/bin/ssh")) hits.push(path.relative(root, file));
  } };
  walk(path.join(root, "src"));
  assert.deepEqual(hits.sort(), [sanctioned], "no other source file may invoke the system ssh binary");
  const forwarder = fs.readFileSync(path.join(root, sanctioned), "utf8");
  const imports = [...forwarder.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)].map(m => m[1]);
  assert.equal(imports.length, 1, "exactly one child_process import seam");
  assert.deepEqual(imports[0].split(",").map(t => t.trim()).sort(), ["spawn", "spawnSync"], "no exec/shell seam may exist");
  assert.doesNotMatch(forwarder, /spawn(?:Sync)?\s*\(\s*["'`]/, "spawn may only take the verified ssh path constant, never a literal binary");
  assert.equal([...forwarder.matchAll(/this\.spawnChild\(\s*([^,]+),/g)].every(m => m[1].trim() === "this.sshPath"), true, "every child spawn binds the verified ssh path");
  assert.match(forwarder, /spawnSync\(\s*sshPath/, "the parse-only config probe binds the verified ssh path");
  assert.match(forwarder, /"-N"/, "the forward must stay non-interactive");
  assert.match(forwarder, /"-L"/, "the forward must be a local port forward");
  assert.doesNotMatch(forwarder, /RemoteCommand|"-t"/, "the forwarder must never run remote commands or allocate a PTY");
  assert.doesNotMatch(forwarder, /(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](ssh|scp|rsync)["']/i, "the ssh path must stay a verified single constant");
});
