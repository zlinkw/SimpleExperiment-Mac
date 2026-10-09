const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultXshellSessionDirs,
  parseXshellSessionContent,
  preferredSimpleForward,
} = require("../../dist/tunnel/XshellSessionScanner.js");

test("xshell session dirs use dynamic user prefix and fixed NetSarang suffix", () => {
  const dirs = defaultXshellSessionDirs("D:\\Users\\Alice");
  assert.equal(dirs.includes("D:\\Users\\Alice\\Documents\\NetSarang Computer\\8\\Xshell\\Sessions"), true);
  assert.equal(dirs.includes("D:\\Users\\Alice\\Documents\\NetSarang Computer\\7\\Xshell\\Sessions"), true);
  assert.equal(dirs.every((dir) => /NetSarang Computer\\[78]\\Xshell\\Sessions$/.test(dir)), true);
});

test("xshell session parser extracts local forward ports", () => {
  const text = [
    "[CONNECTION]",
    "Host=nwpu5",
    "UserName=simple",
    "Port=22",
    "RemoteCommand=",
    "FwdReq_1_Source=localhost",
    "FwdReq_1_Port=18766",
    "FwdReq_1_Host=localhost",
    "FwdReq_1_HostPort=18765",
  ].join("\r\n");
  const info = parseXshellSessionContent(text, "D:\\Sessions\\nwpu5.xsh", "D:\\Sessions");
  assert.equal(info.host, "nwpu5");
  assert.equal(info.forwards[0].localPort, 18766);
  assert.equal(info.forwards[0].remotePort, 18765);
  assert.equal(preferredSimpleForward(info).localPort, 18766);
});