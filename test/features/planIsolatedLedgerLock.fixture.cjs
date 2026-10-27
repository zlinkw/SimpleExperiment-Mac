// 用户裁定 B（2026-10-26）后：跨进程锁协议整体退役，本夹具随之改为 CAS 回归夹具。
// 不拦截任何 fs 方法、不构造/读取任何锁文件；唯一职责是在独立真实进程里进入
// withIsolatedBatchLedger 临界区（此时 basis 身份指纹已按"读一次"记下），挂起等待父进程
// 完成外部改动后，再按指令用该 basis 调 saveIsolatedBatchLedger，并把真实结果原样上报。
const [moduleFile, file, mode, batchId] = process.argv.slice(2);
const ledger = require(moduleFile);
const queued = new Set(), waiting = new Map();
const send = message => { if (process.connected) process.send({ ...message, pid: process.pid }); };
process.on('message', key => {
  const resolve = waiting.get(key);
  if (resolve) { waiting.delete(key); resolve(); } else queued.add(key);
});
const gate = key => queued.delete(key) ? Promise.resolve() : new Promise(resolve => waiting.set(key, resolve));
(async () => {
  if (mode !== 'cas-write-on-cue') throw new Error('unknown fixture mode: ' + mode);
  await ledger.withIsolatedBatchLedger(file, async basis => {
    send({ event: 'entered', fingerprint: basis.fingerprint });
    await gate('write');
    const batches = basis.batches;
    batches.push({ batchId, projectRoot: '/fixture', frozenAt: new Date().toISOString(), plans: [] });
    await ledger.saveIsolatedBatchLedger(file, batches, basis);
  });
  send({ event: 'done' });
  process.disconnect();
})().catch(error => {
  send({ event: 'error', message: String(error.stack || error) });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
