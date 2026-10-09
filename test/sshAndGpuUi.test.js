const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readSource } = require("./_helpers/sourceReader");

const extensionSource = readSource("src/extension.ts");

test("extension exposes tunnel-only connection UI", () => {
  assert.match(extensionSource, /检查服务器配置/);
  assert.match(extensionSource, /启动全部隧道/);
  assert.match(extensionSource, /手动刷新/);
  assert.match(extensionSource, /暂停全部网络/);
  assert.match(extensionSource, /导入离线/);
  assert.match(extensionSource, /127\.0\.0\.1/);
});

test("extension no longer contains direct remote fallback methods", () => {
  for (const forbidden of [
    "runSsh(",
    "connectSshSessions",
    "closeControlMasterSessions",
    "persistent_shell",
    "oneshot",
    "sshTransportMode",
  ]) {
    assert.equal(extensionSource.includes(forbidden), false, forbidden);
  }
});

test("webview hidden state is passed to request budget", () => {
  assert.match(extensionSource, /onDidChangeVisibility/);
  assert.match(extensionSource, /budget\.setHidden/);
});
