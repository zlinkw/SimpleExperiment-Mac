const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../../dist/config/RenamedExtensionStateMigration.js");
const migrationSource = fs.readFileSync(path.join(__dirname, "../../src/config/RenamedExtensionStateMigration.ts"), "utf8");

// Mac 适配：独立标识的 Mac 扩展绝不收养 Windows/ZLK 旧版状态——HostPaths.adoptLegacyWindowsExtensionState
// 恒为 false，migrateRenamedExtensionState 在任何 globalState 读写之前 fail-closed 返回
// { migrated:false, reason:"independent_mac_identity" }。以下用例改为核验：(1) 该门禁在最前且不写任何状态；
// (2) Windows 侧业务不变量仍由纯函数（恢复配置剔除直连 SSH 字段、完整性评分与“更完整才迁移/已完成不覆盖”
// 的比较门槛）原样保留；(3) 迁移版本键使用 simpleExperimentMac.* 身份。断言强度不降，只是承载函数不同。
const LEGACY_PAYLOAD = {
  "zlkCluster.xshellRealtimeTunnelConfig": {
    xshellExePath: "C:/Program Files/NetSarang/Xshell/Xshell.exe",
    hubHost: "hub.example",
    hubUser: "runner",
    savedSessionPath: "C:/sessions/hub.xsh",
    agentProjectDir: "/srv/projects",
    privateKeyPath: "C:/secret/key",
    workerTunnels: [{ id: "gpu-a", hubHost: "gpu.example", hubUser: "runner", savedSessionPath: "C:/sessions/gpu.xsh", privateKeyPath: "C:/secret/gpu" }],
  },
};

function context(current) {
  const values = new Map(Object.entries(current || {}));
  const updates = [];
  return {
    globalStorageUri: { fsPath: "/Users/test/Library/Application Support/Code/User/globalStorage/simple-local.simple-experiment-mac" },
    globalState: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) { updates.push([key, value]); values.set(key, value); },
    },
    values,
    updates,
  };
}

test("the Mac extension refuses legacy adoption before touching global state, even for a complete legacy setup", async () => {
  const state = context({ "simpleExperimentMac.xshellRealtimeTunnelConfig": {} }, LEGACY_PAYLOAD);
  const reads = [];
  const originalGet = state.globalState.get;
  state.globalState.get = (key, fallback) => { reads.push(key); return originalGet(key, fallback); };
  const result = await migration.migrateRenamedExtensionState(state, { readState: () => LEGACY_PAYLOAD });
  assert.deepEqual(result, { migrated: false, reason: "independent_mac_identity" });
  assert.deepEqual(state.updates, [], "the Mac gate must not mark anything checked or write setup/tunnel state");
  assert.deepEqual(reads, [], "the Mac gate must short-circuit before any globalState read");
  assert.equal(state.values.get("simpleExperimentMac.xshellRealtimeTunnelConfig").privateKeyPath, undefined);
});

test("the gate is the first statement and the legacy-adoption flag is a compile-time false", () => {
  assert.match(migrationSource, /if \(!require\("\.\.\/platform\/HostPaths"\)\.adoptLegacyWindowsExtensionState\) return \{ migrated: false, reason: "independent_mac_identity" \};/);
  assert.match(migrationSource, /const globalState = context\?\.globalState;[\s\S]*if \(Number\(globalState\.get\(RENAMED_EXTENSION_STATE_MIGRATION_KEY, 0\)\)/);
  const hostPaths = fs.readFileSync(path.join(__dirname, "../../src/platform/HostPaths.ts"), "utf8");
  assert.match(hostPaths, /export const adoptLegacyWindowsExtensionState = false;/);
});

test("recovery keeps the Xshell runner and strips direct SSH fields from setup and every worker", () => {
  const setup = migration.xshellRecoveryConfig(LEGACY_PAYLOAD["zlkCluster.xshellRealtimeTunnelConfig"]);
  assert.equal(setup.savedSessionRunner, "xshell");
  assert.equal(setup.workerTunnels.length, 1);
  assert.equal(setup.privateKeyPath, undefined);
  assert.equal(setup.sshHost, undefined);
  assert.equal(setup.workerTunnels[0].privateKeyPath, undefined);
  assert.equal(setup.workerTunnels[0].sshConfigAlias, undefined);
  assert.equal(setup.hubHost, "hub.example");
  assert.equal(setup.agentProjectDir, "/srv/projects");
});

test("completeness gates still refuse to overwrite a complete setup and require a strictly better legacy", () => {
  const complete = {
    xshellExePath: "xshell.exe",
    hubHost: "current-hub",
    hubUser: "runner",
    savedSessionPath: "current.xsh",
    agentProjectDir: "/srv/current",
    workerTunnels: [{ id: "current-worker", savedSessionPath: "current-worker.xsh", enabled: true }],
  };
  assert.equal(migration.hasCompletedXshellSetup(complete), true);
  assert.equal(migration.hasCompletedXshellSetup({}), false);
  assert.equal(migration.hasCompletedXshellSetup({ ...complete, workerTunnels: [{ id: "w", enabled: false }] }), false);
  const legacy = { ...complete, workerTunnels: [...complete.workerTunnels, { id: "second-worker", savedSessionPath: "second-worker.xsh" }] };
  assert.ok(migration.xshellConfigCompleteness(legacy) > migration.xshellConfigCompleteness(complete));
  assert.ok(migration.xshellConfigCompleteness(complete) > migration.xshellConfigCompleteness({}));
  // 源码仍按“当前已完整→不覆盖”“旧版不比当前更完整→不迁移”的顺序把关，且先落已检查标记。
  assert.match(migrationSource, /if \(hasCompletedXshellSetup\(current\)\)/);
  assert.match(migrationSource, /xshellConfigCompleteness\(legacy\) <= xshellConfigCompleteness\(current\)/);
  assert.match(migrationSource, /reason: "current_setup_complete"/);
  assert.match(migrationSource, /reason: "no_better_legacy_setup"/);
});

test("migration bookkeeping uses the Mac extension identity keys", () => {
  assert.equal(migration.RENAMED_EXTENSION_STATE_MIGRATION_KEY, "simpleExperimentMac.renamedExtensionStateMigrationVersion");
  assert.equal(migration.LEGACY_EXTENSION_ID, "zlk-local.zlk-cluster-orchestrator");
  assert.ok(Number.isInteger(migration.RENAMED_EXTENSION_STATE_MIGRATION_VERSION));
  assert.match(migrationSource, /const CURRENT_SETUP_KEY = "simpleExperimentMac\.xshellRealtimeTunnelConfig";/);
  assert.match(migrationSource, /const CURRENT_TUNNEL_KEY = "simpleExperimentMac\.tunnelGatewayConfig";/);
  assert.match(migrationSource, /const LEGACY_SETUP_KEY = "zlkCluster\.xshellRealtimeTunnelConfig";/);
});
