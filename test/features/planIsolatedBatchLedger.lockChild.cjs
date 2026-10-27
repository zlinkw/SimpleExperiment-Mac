// 双真实进程回归子进程（非测试本体，经 support.cjs spawnChild fork）。
// 裁定 B（2026-10-26）：锁协议移除后 stale-reader/contender 两个观测模式随锁退役删除；
// 保留 ordinary（进程内链临界区进出事件上报）与 boom（helper 反例）。
const fs = require('node:fs');
const [distFile, file, mode, eventsFile] = process.argv.slice(2);
const inbox = [], waiters = new Map();
process.on('message', m => { const r = waiters.get(m); if (r) { waiters.delete(m); r(); } else inbox.push(m); });
function gate(key) { const i = inbox.indexOf(key); if (i >= 0) { inbox.splice(i, 1); return Promise.resolve(); } return new Promise(r => waiters.set(key, r)); }
const ledger = require(distFile);
if (mode === 'boom') {
  // r28-U1 反例夹具：子进程即时报告真实错误——helper 必须即时拒绝 pending wait 并附诊断，而非伪装 3000ms 超时。
  process.send({ event: 'error', message: 'fixture-boom' });
  process.exitCode = 1;
  process.disconnect();
} else (async () => {
  await ledger.withIsolatedBatchLedger(file, async () => {
    // 临界区物理事件账本：ENTER/LEAVE 由进入 withIsolatedBatchLedger 临界区的进程自身追加；
    // 裁定 B 后同进程串行由进程内链保证、跨进程冲突由写前 CAS fail closed。
    if (eventsFile) fs.appendFileSync(eventsFile, 'ENTER ' + process.pid + '\n');
    process.send({ event: 'entered', pid: process.pid, enteredAt: Date.now() });
    await gate('release');
    if (eventsFile) fs.appendFileSync(eventsFile, 'LEAVE ' + process.pid + '\n');
  });
  process.send({ event: 'done', pid: process.pid });
  process.disconnect();
})().catch(e => { process.send({ event: 'error', message: String((e && e.message) || e) }); process.exitCode = 1; process.disconnect(); });
