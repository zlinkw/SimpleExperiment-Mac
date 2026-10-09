const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../../src/extension/legacy.ts"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

test("SFTP target preparation uses saved plugin fields without external config scans", () => {
  const prepare = section("async prepareSftpTargets(", "sftpServerOptions(target)");
  const hub = section("    hubActualWorkRootTarget(config =", "    workerCodeSyncTargets()");
  const worker = section("    workerActualWorkRootTarget(worker, config =", "    async primaryGitRepository()");
  const identity = section("    sshTransportIdentity(target) {", "    async assertSshTransportIdentities(");
  assert.doesNotMatch(prepare, /syncXshellConfigBeforeNetwork|refreshLocalSshConfig|refreshXshellSessionLibrary/);
  assert.doesNotMatch(hub, /sessionInfoForPath/);
  assert.doesNotMatch(worker, /sessionInfoForPath/);
  assert.doesNotMatch(identity, /sessionInfoForPath|sshConfigServers|refreshLocalSshConfig/);
  assert.match(worker, /worker\.workerHost/);
  assert.match(hub, /config\.hubHost/);
  assert.match(worker, /host: firstNonEmpty\(worker\.workerHost, worker\.hubHost, worker\.transferHost\)/);
  assert.match(hub, /host: firstNonEmpty\(config\.hubHost, config\.transferHost\)/);
});
