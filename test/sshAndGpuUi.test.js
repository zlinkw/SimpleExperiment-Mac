const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readSource } = require("./_helpers/sourceReader");

const extensionSource = readSource("src/extension.ts");

test("extension exposes tunnel-only connection UI", () => {
  assert.match(extensionSource, /检查服务器配置/);
  assert.match(extensionSource, /启动全部隧道/);
  // Mac 发布名的真实持有者：manualRefresh 命令注册于 extension/legacy.ts，
  // 对外标题为“手动快照”；暂停命令标题为“暂停网络活动”。断言按 Mac 命令名前缀保留 .403 的完整注册形态。
  assert.match(extensionSource, /registerCommand\("simpleExperimentMac\.manualRefresh", \(\) => provider\?\.manualSnapshot\(\)\)/);
  assert.match(extensionSource, /暂停网络活动/);
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
