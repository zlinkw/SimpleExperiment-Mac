const assert = require("node:assert/strict");
const test = require("node:test");

const { parseLocalSshConfig } = require("../../dist/tunnel/LocalSshConfig.js");
const {
  buildSftpServerOptions,
  resolveSshTransportIdentity,
} = require("../../dist/tunnel/SshTransportIdentity.js");

const servers = parseLocalSshConfig(`
Host NWPU5
  HostName 10.68.10.238
  User simple
  IdentityFile C:/Users/ZLK/.ssh/simple

Host campus
  HostName 10.12.34.56
`, "C:/Users/ZLK/.ssh/config");

test("Plugin address wins over a stale configured alias", () => {
  const identity = resolveSshTransportIdentity({
    id: "nwpu5",
    label: "NWPU5",
    sshConfigAlias: "NWPU5",
    host: "10.68.10.238",
    transferHost: "10.68.10.238",
    resolvedHost: "10.68.10.238",
  }, { sshServers: servers });
  assert.equal(identity.transportHost, "10.68.10.238");
  assert.equal(identity.sshConfigHost, "");
  assert.equal(identity.sshConfigAlias, "");
  assert.equal(identity.networkHost, "10.68.10.238");
});

test("Saved manual address ignores OpenSSH and Xshell aliases", () => {
  const serversWithBoth = parseLocalSshConfig(`
Host saved-alias
  HostName 10.0.0.1

Host session-alias
  HostName 10.0.0.2
`);
  const identity = resolveSshTransportIdentity({
    sshConfigHost: "saved-alias",
    sessionName: "session-alias",
    host: "10.0.0.1",
  }, { sshServers: serversWithBoth, session: { name: "session-alias" } });
  assert.equal(identity.transportHost, "10.0.0.1");
  assert.equal(identity.source, "network_host");
});

test("Xshell session name does not override a manual address", () => {
  const identity = resolveSshTransportIdentity({
    id: "nwpu5",
    label: "NWPU5",
    host: "10.68.10.238",
  }, { sshServers: servers, session: { name: "NWPU5", host: "10.68.10.238" } });
  assert.equal(identity.transportHost, "10.68.10.238");
  assert.equal(identity.source, "network_host");
});

test("Manual address is not replaced with an OpenSSH Host alias", () => {
  const identity = resolveSshTransportIdentity({
    id: "remote",
    label: "remote",
    host: "10.68.10.238",
  }, { sshServers: servers });
  assert.equal(identity.transportHost, "10.68.10.238");
  assert.equal(identity.networkHost, "10.68.10.238");
});

test("SimpleSFTP options pass the manual address through every host field", () => {
  const target = {
    id: "nwpu5",
    label: "NWPU5",
    host: "10.68.10.238",
    user: "simple",
    port: 22,
    remotePath: "/data/custom-root",
  };
  const identity = resolveSshTransportIdentity(target, { sshServers: servers });
  const options = buildSftpServerOptions(target, identity);
  assert.equal(options.host, "10.68.10.238");
  assert.equal(options.sftpHost, "10.68.10.238");
  assert.equal(options.sshHost, "10.68.10.238");
  assert.equal(options.transferHost, "10.68.10.238");
  assert.equal(options.resolvedHost, "10.68.10.238");
  assert.equal(options.sshConfigHost, "");
  assert.equal(options.sshConfigAlias, "");
  assert.equal(options.networkHost, "10.68.10.238");
});

test("A target without an SSH alias falls back to its IP", () => {
  const identity = resolveSshTransportIdentity({
    id: "plain",
    label: "plain",
    host: "192.168.1.8",
  }, { sshServers: [] });
  assert.equal(identity.transportHost, "192.168.1.8");
  assert.equal(identity.sshConfigAlias, "");
  assert.equal(identity.networkHost, "192.168.1.8");
});

test("manual Worker address wins over stale OpenSSH and Xshell names", () => {
  const staleServers = parseLocalSshConfig("Host NWPU2\n  HostName 10.216.245.2\n");
  const identity = resolveSshTransportIdentity({
    id: "nwpu2",
    label: "NWPU2",
    host: "-",
    transferHost: "-",
    workerHost: "10.69.24.150",
    sshConfigAlias: "qgking.2",
  }, { sshServers: staleServers, session: { name: "qgking.2", host: "10.216.245.2" } });
  assert.equal(identity.transportHost, "10.69.24.150");
  assert.equal(identity.sshConfigAlias, "");
});

test("manual server address has priority over a legacy SFTP address", () => {
  const identity = resolveSshTransportIdentity({
    transferHost: "10.70.50.180",
    workerHost: "10.69.24.150",
    sshConfigAlias: "NWPU2",
  }, { sshServers: servers });
  assert.equal(identity.transportHost, "10.69.24.150");
  assert.equal(identity.sshConfigAlias, "");
});

test("legacy SFTP address remains a fallback when no server address is configured", () => {
  const identity = resolveSshTransportIdentity({ transferHost: "10.70.50.180" });
  assert.equal(identity.transportHost, "10.70.50.180");
});
