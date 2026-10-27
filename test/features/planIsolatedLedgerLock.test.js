// 用户裁定 B（2026-10-26）：账本跨进程锁文件全链路移除，改为"写一次读＋写前指纹比对（CAS）"。
// 本套件随之从"锁协议回归"改写为"CAS 写前比对回归"（文件名保留以维持 test-workflow 登记与历史追溯）。
// 随锁退役的原用例（行为已随锁移除，逐条对应退役清单）：
//   原:57  'r17-7 migrated: a stale observer and a third real contender cannot remove the later owner…'（锁获取/互斥/遗留锁保留）
//   原:85  'an owner crash leaves the exact orphan lock and ledger intact…'（崩溃遗留锁不自动恢复）
//   原:96  'releasing a lost owner never removes foreign token bytes'（锁 token 释放核对）
//   原:107 'a lost writer cannot publish its staged bytes and cannot release the foreign lock'（token fencing——
//          "写前发现他人改动⇒零写入"的核心语义由 CAS 继承，本文件新用例 3/5 覆盖；token 机制本体已移除）
//   原:125 'a zero-byte lock ages into the abandoned classification without any mutation'（零字节只读分类）
//   原:153 'promotion errors report once per signature per window with suppressed counts'（按签名限流）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const moduleFile = path.resolve(__dirname, '../../dist/features/PlanIsolatedBatchLedger.js');
const ledger = require(moduleFile);
const fixture = path.join(__dirname, 'planIsolatedLedgerLock.fixture.cjs');

function seed(withFile = true) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'se-ledger-cas-gate-'));
  const file = path.join(directory, 'ledger.json');
  if (withFile) fs.writeFileSync(file, JSON.stringify({ version: 2, batches: [{ batchId: 'seed', projectRoot: '/fixture', frozenAt: '2026-10-22T00:00:00Z', plans: [] }] }));
  return file;
}
function spawn(t, file, batchId) {
  const child = fork(fixture, [moduleFile, file, 'cas-write-on-cue', batchId], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const events = [], listeners = new Set();
  let output = '', exited = false;
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  child.on('message', message => { events.push(message); for (const listener of [...listeners]) listener(message); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true; resolve({ code, signal }); for (const listener of [...listeners]) listener({ event: 'closed' });
  }));
  const send = message => { if (child.connected) child.send(message, () => {}); };
  function wait(event) {
    const found = events.find(message => message.event === event);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('IPC timeout: ' + event + ' ' + output)), 5000);
      function finish(error, message) { clearTimeout(timer); listeners.delete(receive); error ? reject(error) : resolve(message); }
      function receive(message) {
        if (message.event === event) finish(undefined, message);
        else if (message.event === 'error' || message.event === 'closed') finish(Error(message.message || 'Child closed before ' + event + ': ' + output));
      }
      listeners.add(receive);
      const error = events.find(message => message.event === 'error');
      if (error || exited) receive(error || { event: 'closed' });
    });
  }
  t.after(async () => {
    if (exited) return;
    send('write'); // 解锁可能仍挂起的夹具，让它按真实路径收尾。
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 800); })]);
    clearTimeout(timer);
    if (!exited) { child.kill('SIGTERM'); await closed; } // Only this fixture's own child.
  });
  return { child, events, closed, send, wait };
}
const tmpResidues = file => fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'));

test('去锁后不再创建任何锁文件；历史遗留 .lock 垃圾无害——不读、不删、不挡写', async t => {
  const file = seed();
  const stray = JSON.stringify({ token: 'legacy-garbage' });
  fs.writeFileSync(file + '.lock', stray);
  await ledger.freezeBatchScope(file, { batchId: 'b-cas', projectRoot: '/fixture' }, [{ planFile: 'p.yaml', submissionOperationId: 'op-1' }]);
  await ledger.freezeBatchScope(file, { batchId: 'b-cas-2', projectRoot: '/fixture' }, [{ planFile: 'q.yaml', submissionOperationId: 'op-2' }]);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed', 'b-cas', 'b-cas-2']);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), stray, '残留 .lock 一字不动：没有代码再读它');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.lock') && name !== path.basename(file) + '.lock'), [], '不得再创建任何新锁文件');
  assert.deepEqual(tmpResidues(file), [], '成功路径不留临时文件');
});

test('同一文件同一时刻只有一个本进程写入者：进程内链并发排队，两批事实都不丢', async () => {
  const file = seed();
  await Promise.all([
    ledger.freezeBatchScope(file, { batchId: 'c-1', projectRoot: '/fixture' }, [{ planFile: 'a.yaml', submissionOperationId: 'op-a' }]),
    ledger.freezeBatchScope(file, { batchId: 'c-2', projectRoot: '/fixture' }, [{ planFile: 'b.yaml', submissionOperationId: 'op-b' }]),
  ]);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId).sort(), ['c-1', 'c-2', 'seed'],
    '并发提交经内存链排队串行落盘：CAS 不需要牺牲任何一条已接受的事实');
});

test('临界区持据期间另一进程改写账本 ⇒ 写前比对拒绝：零写入、ISOLATED_BATCH_LEDGER_STALE、临时文件保留为证据', async t => {
  const file = seed(), holder = spawn(t, file, 'forbidden-stale');
  await holder.wait('entered'); // 子进程已读账本并记下指纹，此刻临界区仍持有 basis。
  await ledger.freezeBatchScope(file, { batchId: 'foreign', projectRoot: '/fixture' }, [{ planFile: 'f.yaml', submissionOperationId: 'op-f' }]);
  const before = fs.readFileSync(file, 'utf8');
  holder.send('write');
  const failed = await holder.wait('error');
  assert.match(failed.message, /ISOLATED_BATCH_LEDGER_STALE/);
  assert.match(failed.message, /可能有第二个窗口在写，请只保留一个窗口后重试/);
  assert.match(failed.message, /期望指纹/); assert.match(failed.message, /写前实况/);
  await holder.closed;
  assert.equal(fs.readFileSync(file, 'utf8'), before, '被拒轮次对账本零写入，其他进程的结果原样保留');
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed', 'foreign']);
  assert.equal(tmpResidues(file).length, 1, '本欲写入的临时文件按既有规则保留为证据、不删');
});

test('身份变化但内容相同（外部 touch）⇒ 慢路径确认内容一致后继续落盘；不同 ⇒ 拒绝', async t => {
  const file = seed(), holder = spawn(t, file, 'touched-writer');
  await holder.wait('entered');
  const target = new Date(Date.now() + 2 * 3600_000);
  fs.utimesSync(file, target, target); // 只改时间戳（连带 ctime），字节不变。
  holder.send('write');
  await holder.wait('done');
  assert.deepEqual(await holder.closed, { code: 0, signal: null });
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed', 'touched-writer'],
    'touch 类外部触碰不阻塞合规写入');
  assert.deepEqual(tmpResidues(file), [], '慢路径放行后临时文件已 rename，不残留');
});

test('依据=文件缺失：另一进程在写前创建了账本 ⇒ 意外出现同样 fail closed 零写入', async t => {
  const file = seed(false), holder = spawn(t, file, 'forbidden-creator');
  const entered = await holder.wait('entered');
  assert.equal(entered.fingerprint, null, '文件缺失时依据指纹为 null');
  await ledger.freezeBatchScope(file, { batchId: 'seed-first', projectRoot: '/fixture' }, [{ planFile: 's.yaml', submissionOperationId: 'op-s' }]);
  const before = fs.readFileSync(file, 'utf8');
  holder.send('write');
  const failed = await holder.wait('error');
  assert.match(failed.message, /ISOLATED_BATCH_LEDGER_STALE/);
  assert.match(failed.message, /文件意外出现/);
  await holder.closed;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed-first']);
});
