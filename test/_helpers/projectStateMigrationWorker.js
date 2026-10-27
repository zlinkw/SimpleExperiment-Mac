"use strict";
// r21/r24 跨进程竞态 worker：一个真实 node 子进程扮演四种角色之一——
//   migrate <root> <legacy> <target> <marker> [signal] [gate] [hold]
//     目录快照迁移一轮；有 signal 时在迁移租约内发布 f1 后发信号并等闸门（模拟"仍在导入中"）；
//     hold="hold" 时再在同一个持有上下文里 acquire 同 scope（命中 parent 上下文句柄），
//     用其 assertHeld（=对磁盘注册表的 assertOwned）做持有期间的跨进程验证。
//   release <root> <legacy> <target> <marker> <recordFile>
//     第三进程执行一次终态释放（与迁移共用同一 marker scope 租约）。
//   receipt-hold <root> <storage> <opId> <signal> <gate>
//     在 withProjectStateMigrationLease 的真实持有上下文内：assertOwned → 发信号 → 等闸门，
//     放行后才 host.load(opId) 完成导入（同 ALS 上下文嵌套 acquire 命中 parent、复用不冲突）。
//   receipt-release <root> <storage> <opId>
//     第三进程执行一次 PlanRunHost.releaseSettled。
// 租约嵌套复用依赖 AsyncLocalStorage（仅生产 run() 建立上下文），所以验证/屏障必须放在生产
// 租约回调内部、绝不裸 acquire 外层自锁。只与 dist/ 下的生产 API 交互；不读测试内部状态、不写源码/Git。
const fs = require("node:fs");
const path = require("node:path");
const P = require("../../dist/features/ProjectStatePaths.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const [mode, projectRoot, second, third, marker, extra1, extra2, extra3] = process.argv.slice(2);
const acquireHeldContextHandle = async markerPath => {
  const { HostOperationLeaseManager } = require("../../dist/core/HostOperationLease.js");
  return await new HostOperationLeaseManager().acquire({
    pluginId: "simple-local.simple-experiment-mac", workspaceUri: String(projectRoot), hostProjectPath: projectRoot,
    actionType: "project-state-migrate", actionLabel: "导入项目旧快照记录", waitForConflict: true,
    resources: [{ server: "local", project: path.dirname(markerPath), target: markerPath }],
  }); // 在持有上下文内命中 parent → assertHeld 即对磁盘注册表的 assertOwned
};
const waitGate = async (signal, gate) => {
  fs.writeFileSync(signal, "1");
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(gate)) { if (Date.now() > deadline) throw Error("gate timeout"); await sleep(20); }
};
(async () => {
  if (mode === "migrate") {
    let published = 0, assertHeldInside;
    await P.ensureProjectDirectorySnapshotsMigrated(projectRoot, second, third, /^f\d\.json$/, marker, async name => {
      published += 1;
      if (name !== "f1.json" || !extra1) return;
      if (extra3 === "hold") { await (await acquireHeldContextHandle(marker)).assertHeld(); assertHeldInside = "ok"; } // 迁移中途、租约仍在本人手里
      await waitGate(extra1, extra2);
    });
    process.stdout.write(JSON.stringify({ role: "migrate", published, assertHeldInside }));
  } else if (mode === "release") {
    const outcome = await P.releaseMigratedProjectSnapshotRecord(projectRoot, marker, extra1);
    process.stdout.write(JSON.stringify({ role: "release", outcome }));
  } else if (mode === "receipt-hold" || mode === "receipt-release") {
    const { cleanupDigest } = require("../../dist/features/PlanCleanup.js");
    const { PlanRunHost } = require("../../dist/extension/PlanRunHost.js");
    const host = new PlanRunHost({ context: { globalStorageUri: { fsPath: second } }, loadDistributedQueue: async () => ({ plans: [] }) }, projectRoot);
    if (mode === "receipt-release") {
      process.stdout.write(JSON.stringify({ role: "receipt-release", outcome: await host.releaseSettled(third, "submission-succeeded") }));
      return;
    }
    const markerFile = P.projectStateFile(projectRoot, "simple-experiment", "migrations",
      "run-submissions-" + cleanupDigest(projectRoot) + ".done.json");
    let assertHeld;
    const record = await P.withProjectStateMigrationLease(projectRoot, markerFile, "project-state-migrate", "导入项目旧快照记录", async () => {
      const handle = await acquireHeldContextHandle(markerFile); // 命中本次迁移租约的 parent 上下文
      await handle.assertHeld();
      await waitGate(marker, extra1); // receipt 模式的 signal/gate 落在第 5/6 槽：持有租约且不导入，第三进程必须排队
      const loaded = await host.load(third); // 闸门放行后：同一持有上下文内导入 + marker 发布
      await handle.assertHeld();
      assertHeld = "ok";
      return loaded;
    });
    process.stdout.write(JSON.stringify({ role: "receipt-hold", markerValue: record && record.input && record.input.marker, assertHeld }));
  } else throw Error("unknown mode: " + mode);
})().catch(error => { process.stdout.write(JSON.stringify({ error: String(error && error.message || error) })); process.exitCode = 1; });
