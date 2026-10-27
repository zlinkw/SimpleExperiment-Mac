const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { UpdateGate, parseProcessStartMs, parseStartTimesOutput, parseProcessSnapshot, observationsFromSnapshot, enumerationCommand } = require('../../dist/updates/UpdateGate');

// F15 回归安全矩阵（plan r13/r14 + r15 R51–R57，证据 E16g/E16h/F17/F18）：
// 旧 v2 根缺 processId（1b8acce2~ac3b9836 writer，宿主 79 条）与 PID 复用（宿主根缺PID 79 条 + 显式PID
// 6397137…:PID35152 被 Edge identity_helper 复用，R52）两类记录的兼容语义 + 保守等待/探测异常/侧车并集安全矩阵。
// 接缝=构造注入 { processStartedAt, processStartTimes(pids,signal,timeoutMs), onPoll }。
// R56 纪律：pending 用例先等 onPoll 进入点闩（首轮判定完成）再短时观察，finally abort+await 原 wait 结算；
// 只读守卫直接 await 不吞错。R51：Windows 默认 provider 输出显式 epoch 毫秒（宿主实证旧 StartTime JSON
// 为 /Date(1792803730983)/，Date.parse=NaN，日志 985ce89f-65e7-4af9-b95d-1f97d5ad555a-stdout.log）。
// 夹具字段取自宿主真实快照；全程只写临时目录，绝不改宿主路径。Linux 上原生 Windows 执行项按平台明确不跑，
// 但 R51 用真实 Node 进程 PID + 真实解析函数 parseStartTimesOutput 做正向放行（非纯 Map 注入）。
// R63（plan r20/F22）：默认 Windows provider=一次完整 GetProcesses 枚举信封（自PID在场才可信任全集）；
// exited 仅由完整成功全集缺席生成（同ESRCH），EPERM/缺行/失败/截断/伪完整一律 unknown 保守等待。

const T0 = Date.parse('2026-09-28T17:58:56.694Z'); // 宿主非空旧根 3dda869b 的真实 mtime
function makeWorld(testObject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-legacy-lease-'));
  testObject.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leasePath = path.join(root, 'lease.json');
  return { leasePath, dir: leasePath + '.resources-v2' };
}
function registryFile(world, record) {
  fs.mkdirSync(world.dir, { recursive: true });
  return path.join(world.dir, crypto.createHash('sha256').update(String(record.windowId) + Math.random()).digest('hex') + '.json');
}
function writeRegistry(world, record, mtimeMs = T0) {
  const file = registryFile(world, record);
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}
function writeRaw(world, file, text, mtimeMs = T0) { // 损坏/孤槽夹具：任意原始字节，含非JSON
  fs.mkdirSync(world.dir, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}
function legacyRoot(overrides) { return Object.assign({ schemaVersion: 2, windowId: 'testhost:31337:11111111-2222-3333-4444-555555555555', ticket: 0, choosing: false, admissionExpiresAt: 0, leases: [] }, overrides); }
function legacyLease(pid, windowId, atMs, omit) {
  const lease = { pluginId: 'simple-local.simple-experiment', workspaceUri: 'file:///w', hostProjectPath: 'C:/proj', actionType: 'queue-write', actionLabel: '队列写入',
    resources: [{ server: 'local', project: 'C:/proj', target: 'C:/proj' }], schemaVersion: 1, leaseId: 'lease-1', windowId, processId: pid, resourceFile: 'x.json',
    createdAt: new Date(atMs).toISOString(), heartbeatAt: new Date(atMs).toISOString(), expiresAt: new Date(atMs + 30000).toISOString() };
  if (omit) delete lease[omit];
  return lease;
}
async function settleWithin(promise, ms) {
  return await Promise.race([promise.then(() => ({ state: 'resolved' }), error => ({ state: 'rejected', error })),
    new Promise(resolve => setTimeout(() => resolve({ state: 'pending' }), ms))]);
}
function pollLatch() { let fire; const first = new Promise(resolve => { fire = resolve; }); return { first, onPoll: () => fire() }; }
// R56：先等进入点闩（首轮判定完成、正在睡眠）再短时观察；R14：取消后必须 await 原 wait 结算，禁止悬空任务。
async function assertWaitsThenCancel(wait, latch, controller, why) {
  try {
    const latched = await settleWithin(latch.first, 4000);
    assert.equal(latched.state, 'resolved', 'gate 必须在 4s 内完成首轮判定进入等待；未进入即失败');
    assert.equal((await settleWithin(wait, 30)).state, 'pending', why);
    controller.abort(Error('test-window-end'));
    const settled = await settleWithin(wait, 3000);
    assert.equal(settled.state, 'rejected', '取消后原wait必须以中止错误结算，禁止悬空任务结束测试');
    if (settled.state === 'pending') throw Error('取消后wait仍未结算');
    assert.match(String(settled.error && settled.error.message), /test-window-end/);
  } catch (error) { controller.abort(error); throw error; }
}
function newAbort() { return new AbortController(); }
function snapshot(dir) { return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')])); }

const DEAD = () => false;
const LIVE = () => true;

test('旧v2空闲根（根缺PID、windowId含PID段）：死主证明后放行，不得报损坏', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'resolved', '空闲旧记录+确定死主必须放行；修复前生产抛"损坏"即此断言红');
});

test('旧v2崩在admission中段（choosing=true、admission早已过期、leases空）：确定死主放行', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ choosing: true, admissionExpiresAt: T0 + 30000 }));
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'resolved', 'admission 30秒窗口早已过期且窗主确定退出不构成持有');
});

test('旧v2含过期lease（内层PID与windowId一致）：确定死主退出证明后放行', async t => {
  const world = makeWorld(t);
  const row = legacyRoot(); row.leases = [legacyLease(31337, row.windowId, T0)];
  writeRegistry(world, row);
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'resolved', '对应宿主3dda869b/5fe9c397/a6fec7cc三例');
});

test('旧v2 PID复用（StartTime晚于全部界限+5s余量）：不可能是旧主，放行', async t => {
  const world = makeWorld(t);
  const row = legacyRoot(); row.leases = [legacyLease(31337, row.windowId, T0)];
  writeRegistry(world, row);
  const startedAt = new Map([[31337, T0 + 10 * 60000]]); // 晚于 mtime/expiresAt/admission 全部界限
  const result = await settleWithin(new UpdateGate(world.leasePath, LIVE, { processStartedAt: pid => startedAt.get(pid) }).wait(), 1500);
  assert.equal(result.state, 'resolved', '有界StartTime复用证明成立必须放行');
});

test('R52 现代显式PID根（ticket=1、PID被新进程复用、宿主6397137…形状）：批量StartMs证明后放行', async t => {
  const world = makeWorld(t);
  writeRegistry(world, { schemaVersion: 2, windowId: '宿舍:35152:9c22a918-4a3e-4f6b-8e2d-1f0e5d6c7b8a', processId: 35152, ticket: 1, choosing: false, admissionExpiresAt: 0, leases: [] });
  let seenPids = null;
  const result = await settleWithin(new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => { seenPids = pids.slice(); return new Map([[35152, T0 + 10 * 60000]]); } }).wait(), 1500);
  assert.equal(result.state, 'resolved', '显式根同样必须走统一复用证明（Edge复用PID不再把更新卡死300s）；修复R52前explicit分支直接ownerAlive即卡');
  assert.deepEqual(seenPids, [35152], '显式根PID必须进入批量探测');
});

test('R52 现代显式PID根原主仍活（StartTime早于界限）：继续阻断', async t => {
  const world = makeWorld(t);
  writeRegistry(world, { schemaVersion: 2, windowId: 'testhost:35152:9c22a918-4a3e-4f6b-8e2d-1f0e5d6c7b8a', processId: 35152, ticket: 1, choosing: false, admissionExpiresAt: 0, leases: [] });
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map([[pids[0], T0 - 3600000]]), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '证明不成立的原主必须继续等待，绝不按ticket过期偷放');
});

test('PID复用证明不成立（旧记录StartTime早于界限）：继续阻断，绝不按过期偷放', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ choosing: true, admissionExpiresAt: T0 + 30000 }));
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartedAt: () => T0 - 3600000, onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '活主即使admission/心跳过期仍须等待（宿主pid14764场景的反面保护）');
});

test('StartTime缺失：unknown不得冒充退出证明，继续等待', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartedAt: () => undefined, processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '无时间来源必须保守等待');
});

test('无注入探测时非win32默认不得spawn冒充：缺PID活主保守等待', { skip: process.platform === 'win32' ? '本例验证非win32默认不spawn语义；win32下fake PID可能被真进程复用，原生正向另见R60专用例' : false }, async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { onPoll: latch.onPoll }); // 默认依赖：win32=一次有界Get-Process，其他平台一律unknown
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '非Windows无可靠时间来源时必须unknown→等待');
});

test('缺PID且windowId无PID段：归属不可导出，即使空闲也保守等待（r14保守规则）', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: 'testhost:legacyWindow:00000000-0000-4000-8000-000000000001' }));
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '进程归属完全不可导出时禁止按空闲/过期放行');
});

test('非ASCII主机名windowId（宿主"宿舍:PID:UUID"形状）：PID段严格解析后死主放行', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: '宿舍:31337:11111111-2222-3333-4444-555555555555' }));
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'resolved', '非ASCII主机名不得破坏PID段恢复');
});

test('R54 显式非法根PID一律显式拒绝且不回退windowId：null/字符串/负数/零/超范围', async t => {
  for (const bad of [null, '31337', -1, 0, 2 ** 31, 5000000000]) {
    const world = makeWorld(t);
    writeRegistry(world, legacyRoot({ processId: bad }));
    const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
    assert.equal(result.state, 'rejected', '显式 processId=' + JSON.stringify(bad) + '（含null=显式键存在）必须拒绝');
    assert.match(String(result.error && result.error.message), /无效/, '显式非法PID必须显式拒绝');
    assert.doesNotMatch(String(result.error && result.error.message), /损坏/, '非法显式字段与历史缺字段必须区分文案');
  }
});

test('R54 内层身份不完备即拒绝：缺PID/非法PID/内层windowId缺失或与根不一致', async t => {
  const world = makeWorld(t);
  const missing = legacyRoot(); missing.leases = [legacyLease(31337, missing.windowId, T0, 'processId')];
  writeRegistry(world, missing);
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected', '内层缺PID不是best-effort忽略');
  assert.match(String(result.error && result.error.message), /内层进程号|无效/);
  const world2 = makeWorld(t);
  const mismatch = legacyRoot(); mismatch.leases = [legacyLease(31337, 'testhost:31337:other-window', T0)];
  writeRegistry(world2, mismatch);
  const result2 = await settleWithin(new UpdateGate(world2.leasePath, DEAD).wait(), 1500);
  assert.equal(result2.state, 'rejected');
  assert.match(String(result2.error && result2.error.message), /矛盾/);
});

test('根PID与内层lease PID矛盾：拒绝，不任选一边', async t => {
  const world = makeWorld(t);
  const row = legacyRoot({ processId: 41000 });
  row.leases = [legacyLease(31337, row.windowId, T0)];
  writeRegistry(world, row);
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected', '矛盾身份字段必须拒绝');
  assert.match(String(result.error && result.error.message), /无效|无法核实|矛盾/);
});

test('R54 时间界限不完整的记录不得被造出退出证明：lease缺时间→等待', async t => {
  const world = makeWorld(t);
  const row = legacyRoot(); row.leases = [legacyLease(31337, row.windowId, T0, 'heartbeatAt')];
  writeRegistry(world, row);
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartedAt: () => T0 + 10 * 60000, processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, 'heartbeatAt缺失→上界不完整→即使sync时间"足够晚"也必须等待');
});

test('R54 未来StartTime不可信：晚于now的证明不得放行', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartedAt: () => Date.now() + 600000, processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '未来时间一律unknown→等待（时钟异常/伪造不得变退出证明）');
});

test('R54 复用证明5s余量边界：恰好+5000等待、+5001放行', async t => {
  const worldA = makeWorld(t);
  writeRegistry(worldA, legacyRoot()); // bound=mtime=T0（admission 0、无lease）
  const latch = pollLatch(), controller = newAbort();
  const gateA = new UpdateGate(worldA.leasePath, LIVE, { processStartedAt: () => T0 + 5000, processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gateA.wait(controller.signal), latch, controller, 'start=bound+5000 不严格大于边界，必须等待');
  const worldB = makeWorld(t);
  writeRegistry(worldB, legacyRoot());
  const result = await settleWithin(new UpdateGate(worldB.leasePath, LIVE, { processStartedAt: () => T0 + 5001 }).wait(), 1500);
  assert.equal(result.state, 'resolved', 'start=bound+5001 严格大于边界即复用证明成立');
});

test('R51/R63 默认provider为完整枚举命令显式epoch毫秒；真实格式解析边界（含宿主/Date(…)实证形）', () => {
  const command = enumerationCommand();
  assert.match(command, /\[System\.Diagnostics\.Process\]::GetProcesses\(\)/, 'R63：一次完整枚举快照（旧Get-Process -Id任一PID缺失即exit1整批被吞——宿主F22实证）');
  assert.match(command, /ToUnixTimeMilliseconds/, '命令必须显式输出epoch毫秒而非裸StartTime（宿主实证裸StartTime= /Date(1792803730983)/）');
  assert.match(command, /queryPid=\$PID/, '信封必须携带查询自PID（r20 #2：自在场是全集可信前提）');
  assert.equal(/\bforeach\s*\(\s*\$PID\b/.test(command), false, 'r20 #1：$PID是PowerShell只读自动变量，foreach不得使用');
  assert.match(command, /\$ErrorActionPreference='Stop'/, '枚举步骤异常必须整体失败，防止伪完整');
  const now = Date.parse('2026-10-24T01:02:11.283Z');
  assert.deepEqual([...parseStartTimesOutput('[{"Id":35152,"StartMs":1792803730983}]', now)], [[35152, 1792803730983]], '旧数组格式仅作时间序列：epoch毫秒必须解析（R63：绝不能凭其缺行断死）');
  assert.equal(parseProcessStartMs('/Date(1792803730983)/', now), 1792803730983, '/Date(ms)/显式识别（Date.parse对它是NaN——宿主实证）');
  assert.equal(Number.isFinite(Date.parse('/Date(1792803730983)/')), false, '反证：Date.parse确实无法读旧JSON形');
  assert.equal(parseProcessStartMs(new Date(now - 1000).toISOString(), now), now - 1000, '显式ISO可信');
  assert.equal(parseProcessStartMs(now + 10, now), undefined, '未来不可信');
  assert.equal(parseProcessStartMs(1e21, now), undefined, '超安全整数范围数值不可信（R56/R54 helper安全整数）');
  assert.equal(parseProcessStartMs('99999999999999999999', now), undefined, '超安全整数字符串不可信');
  assert.equal(parseProcessStartMs('not-a-date', now), undefined);
  assert.deepEqual([...parseStartTimesOutput('{"Id":7,"StartMs":' + (now - 5000) + '}', now)], [[7, now - 5000]], '单对象（非数组）JSON也要处理（同样仅作时间序列）');
  assert.equal(parseStartTimesOutput('', now).size, 0, '空输出=无信息，绝不冒充退出证明');
});

test('R51/R63 注入捕获枚举信封+真实解析/观察函数判定链正向（非原生执行；原生win32见下两例）', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: os.hostname() + ':' + process.pid + ':11111111-2222-3333-4444-555555555555' }));
  // 旧足够空闲（mtime=T0）+ 本测试Node进程PID在可信全集内且有时间；注入生产枚举命令文本检查+真实 parseProcessSnapshot/observationsFromSnapshot
  const envelope = JSON.stringify({ schemaVersion: 1, complete: true, queryPid: 56524, processIds: [0, 56524, process.pid], rows: [{ Id: process.pid, StartMs: Date.now() - 3600000 }] });
  const gate = new UpdateGate(world.leasePath, undefined, { processStartTimes: async pids => {
    assert.deepEqual(pids, [process.pid], '待证PID必须恰为本进程');
    assert.ok(enumerationCommand().includes('GetProcesses()'), '生产默认命令必须是完整枚举（F22语义）');
    return observationsFromSnapshot(parseProcessSnapshot(envelope, Date.now()), pids);
  } });
  const result = await settleWithin(gate.wait(), 1500);
  assert.equal(result.state, 'resolved', '可信枚举信封内真实PID+旧快照+真实epoch解析 → 必须真实放行');
});

test('R60 win32 原生正向：无provider的 new UpdateGate(leasePath)，当前Node PID + 足够旧快照必须真实放行', { skip: process.platform === 'win32' ? false : '原生Get-Process探测仅在Windows执行；Linux明确跳过，不以fake PID赌语义' }, async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: os.hostname() + ':' + process.pid + ':11111111-2222-3333-4444-555555555555' }));
  const result = await settleWithin(new UpdateGate(world.leasePath).wait(), 12000); // 生产默认：一次原生批量探测（8s帽）+ 保守轮询
  assert.equal(result.state, 'resolved', 'win32原生StartMs证明本进程晚于旧快照 → 必须放行');
});

// R63（plan r20/F22）：完整枚举信封可信语义——退出证明只在"完整成功全集（含自PID在场）"成立；
// EPERM/缺行/失败/截断/伪完整一律 unknown 保守等待。F22 宿主实证：旧批量 Get-Process -Id exit1 吞掉3条有效epoch，
// 25244/42872 Node报EPERM但完整枚举540PID（自56524在场）确认缺席。
test('R63 信封真实解析：自在场+全集合法(允许PID0)+rows时间；在场无时间=unknown、缺席=exited、外集rows忽略', () => {
  const now = Date.parse('2026-10-24T02:00:00.000Z');
  const snap = parseProcessSnapshot(JSON.stringify({ schemaVersion: 1, complete: true, queryPid: 56524, processIds: [0, 56524, 25244, 31337], rows: [{ Id: 31337, StartMs: now - 1000 }, { Id: 25244, StartMs: '/Date(1792803730983)/' }, { Id: 777, StartMs: now - 2000 }] }), now);
  assert.ok(snap, '完整信封必须可信');
  assert.equal(snap.present.size, 4); assert.equal(snap.present.has(0), true, '系统PID0是合法全集成员（r20 #2）');
  assert.equal(snap.times.get(31337), now - 1000);
  assert.equal(snap.times.get(25244), 1792803730983, 'rows沿用parseProcessStartMs，/Date(ms)/同样识别');
  assert.equal(snap.times.has(777), false, '全集外PID的rows时间必须忽略（信封自洽性）');
  const obs = observationsFromSnapshot(snap, [56524, 25244, 31337, 42872]);
  assert.equal(obs.get(56524), 'unknown', '在场但无StartTime必须unknown，绝不顺带放行');
  assert.equal(obs.get(25244), 1792803730983);
  assert.equal(obs.get(31337), now - 1000);
  assert.equal(obs.get(42872), 'exited', '完整成功全集缺席=退出证明（F22 25244/42872实际形态）');
  assert.equal(observationsFromSnapshot(undefined, [9]).get(9), 'unknown', '无可信信封=绝不exited');
});

test('R63 伪完整/结构疑点一律不可信：空/截断/旧格式/坏schema/缺自PID/坏ID → undefined', () => {
  const now = Date.parse('2026-10-24T02:00:00.000Z');
  const bad = [
    ['空输出', ''],
    ['截断JSON', '{"schemaVersion":1,"compl'],
    ['旧数组格式（只可时间序列，不能凭缺行断死）', '[{"Id":14764,"StartMs":1792801976672}]'],
    ['旧单对象格式', '{"Id":7,"StartMs":' + (now - 5000) + '}'],
    ['schemaVersion不符', '{"schemaVersion":2,"complete":true,"queryPid":5,"processIds":[5],"rows":[]}'],
    ['complete非true（伪完整）', '{"schemaVersion":1,"complete":false,"queryPid":5,"processIds":[5],"rows":[]}'],
    ['queryPid非法', '{"schemaVersion":1,"complete":true,"queryPid":0,"processIds":[0],"rows":[]}'],
    ['自PID不在全集（视图不可信）', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":[6,7],"rows":[]}'],
    ['全集含负数', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":[5,-1],"rows":[]}'],
    ['全集含非整数', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":[5,1.5],"rows":[]}'],
    ['全集含字符串', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":["5"],"rows":[]}'],
    ['全集成员超OS合法PID域(2^31)', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":[5,2147483648],"rows":[]}'],
    ['全集成员非安全整数(1e20)', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":[5,1e20],"rows":[]}'],
    ['queryPid超OS合法PID域', '{"schemaVersion":1,"complete":true,"queryPid":2147483648,"processIds":[2147483648],"rows":[]}'],
    ['processIds非数组', '{"schemaVersion":1,"complete":true,"queryPid":5,"processIds":5,"rows":[]}'],
  ];
  for (const [label, stdout] of bad) assert.equal(parseProcessSnapshot(stdout, now), undefined, 'R63：' + label + ' 绝不能产生可信快照/exited');
});

test('R63 批量（F22实景5候选）：3时间证复用+2枚举缺席exited → 一轮放行且批次数恰1', async t => {
  const world = makeWorld(t);
  const w1 = '宿舍:14764:11111111-1111-4111-8111-111111111111';
  writeRegistry(world, { schemaVersion: 2, windowId: w1, choosing: false, ticket: 0, admissionExpiresAt: 0, leases: [legacyLease(14764, w1, T0)] });
  writeRegistry(world, { schemaVersion: 2, windowId: '宿舍:20936:22222222-2222-4222-8222-222222222222', choosing: false, ticket: 1, admissionExpiresAt: 1790781896574, leases: [] });
  writeRegistry(world, { schemaVersion: 2, windowId: '宿舍:35152:33333333-3333-4333-8333-333333333333', processId: 35152, choosing: false, ticket: 1, admissionExpiresAt: 1791735083580, leases: [] });
  writeRegistry(world, { schemaVersion: 2, windowId: '宿舍:25244:44444444-4444-4444-8444-444444444444', choosing: true, ticket: 0, admissionExpiresAt: 0, leases: [] });
  writeRegistry(world, { schemaVersion: 2, windowId: '宿舍:42872:55555555-5555-4555-8555-555555555555', choosing: false, ticket: 1, admissionExpiresAt: 0, leases: [] });
  let calls = 0; let seen = null;
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => {
    calls++; seen = pids.slice();
    return new Map([[14764, 1792801976672], [20936, 1792558114484], [35152, 1792738129915], [25244, 'exited'], [42872, 'exited']]); // 宿主真实StartMs（real-lease-unresolved.json，各自晚于本行bound+5s）
  } });
  const result = await settleWithin(gate.wait(), 1500);
  assert.equal(result.state, 'resolved', '实景5候选（3时间复用证明+2枚举缺席）必须同时放行；任一仍unknown则必须继续等');
  assert.equal(calls, 1, '一次wait全程只允许一次批量查询（R55/R63）');
  assert.deepEqual(seen, [14764, 20936, 25244, 35152, 42872], '数值排序去重必须覆盖全部候选（R57语义保持）');
});

test('R63 在场无时间（EPERM形态）与整批unknown：保守等待，绝不把缺行当放行', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: '宿舍:25244:66666666-6666-4666-8666-666666666666' }));
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '在场无StartTime/枚举异常/伪完整后的unknown必须继续等（F22保守侧保护）');
});

test('R63 win32 原生exited证明：短命Node已退+ownerAlive=true（模拟EPERM活/未知）+无provider默认完整枚举必须真实放行', { skip: process.platform === 'win32' ? false : '原生枚举仅Windows执行；Linux明确跳过，不以fake PID赌语义' }, async t => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'void 0']);
  const shortLivedPid = child.pid;
  assert.ok(Number.isInteger(shortLivedPid) && shortLivedPid > 0, '短命子进程必须有真实PID');
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); // 秒级自然退出（<<10s）
  assert.equal(code, 0, '短命子进程status必须为0，否则本例无效');
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ windowId: os.hostname() + ':' + shortLivedPid + ':77777777-7777-4777-8777-777777777777' }));
  // ownerAlive=true 模拟实景EPERM"活/未知"；不注入provider——走默认原生完整枚举（8s帽）。若PID已被复用，新StartMs晚于旧界限+5s同样真实放行（r20 #4）。
  const result = await settleWithin(new UpdateGate(world.leasePath, () => true).wait(), 12000);
  assert.equal(result.state, 'resolved', '已退PID在可信全集缺席（或已复用时新StartMs晚于界限）必须真实放行');
});

test('R59 内层PID合法但与根PID不等：有根(显式)与缺根(windowId段)双反例都必须拒绝', async t => {
  const worldA = makeWorld(t); // 显式根 31337 + 内层 41000
  const rowA = legacyRoot({ processId: 31337 }); rowA.leases = [legacyLease(41000, rowA.windowId, T0)];
  writeRegistry(worldA, rowA);
  const resultA = await settleWithin(new UpdateGate(worldA.leasePath, DEAD).wait(), 1500);
  assert.equal(resultA.state, 'rejected', '内层PID只校合法不比对根是R59缺口：显式根31337 vs 内层41000 必须拒');
  assert.match(String(resultA.error && resultA.error.message), /矛盾/);
  const worldB = makeWorld(t); // 缺根PID，windowId段31337 + 内层 41000
  const rowB = legacyRoot(); rowB.leases = [legacyLease(41000, rowB.windowId, T0)];
  writeRegistry(worldB, rowB);
  const resultB = await settleWithin(new UpdateGate(worldB.leasePath, DEAD).wait(), 1500);
  assert.equal(resultB.state, 'rejected', '缺根时按windowId段恢复31337，与内层41000矛盾同样必须拒');
  assert.match(String(resultB.error && resultB.error.message), /矛盾/);
});

test('R61 缺admissionExpiresAt的显式空闲记录不得走idle快道：等待而非放行', async t => {
  const world = makeWorld(t);
  const row = legacyRoot({ processId: 31337 }); delete row.admissionExpiresAt; // 显式PID+全空持有，但shape不完整
  writeRegistry(world, row);
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '不完整shape不得当"正常已释放空闲"，缺admission也不能当0造bound');
});

test('R61 完整shape的显式空闲记录正常不阻断（即使ownerAlive=活）', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot({ processId: 31337 })); // 全键齐备、leases空、ticket0、choosing false
  const result = await settleWithin(new UpdateGate(world.leasePath, LIVE).wait(), 1500); // 不经任何provider：idle快道无需探测
  assert.equal(result.state, 'resolved', 'R52/R61：完整正常shape的显式已释放空闲根永不阻断');
});

test('R61(r17) 坏类型idle与非法admission：null走不了快道、负/字符串/非整数admission造不出退出证明', async t => {
  for (const bad of [{ choosing: null }, { ticket: null }, { admissionExpiresAt: null }]) { // 其余键全正常，仅该键=null
    const world = makeWorld(t);
    writeRegistry(world, legacyRoot(Object.assign({ processId: 31337 }, bad)));
    const latch = pollLatch(), controller = newAbort();
    const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
    await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '未知类型 ' + JSON.stringify(bad) + ' 不得按正常已释放idle跳过（r17严格式）');
  }
  for (const badAdmission of [-5, '0', 1.5]) {
    const world = makeWorld(t);
    writeRegistry(world, legacyRoot({ choosing: true, admissionExpiresAt: badAdmission }));
    const latch = pollLatch(), controller = newAbort();
    const gate = new UpdateGate(world.leasePath, LIVE, { processStartedAt: () => T0 + 10 * 60000, onPoll: latch.onPoll }); // sync时间"足够晚"也不得越过不完整bound
    await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, 'admission=' + JSON.stringify(badAdmission) + '（负/字符串/非整数）不得造出退出证明');
  }
});

test('R61(r17) secure reader 读取中真实变更：第2次stat前先真实utimes隔离fixture再读真实stat → 拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-reader-mutation-'));
  const file = path.join(root, 'registry.json');
  fs.writeFileSync(file, JSON.stringify(legacyRoot()), 'utf8');
  const originalMtimeMs = fs.statSync(file).mtimeMs;
  try {
    const core = require('../../dist/core/ResourceOperationLease');
    const fsPromise = require('fs/promises');
    const realOpen = fsPromise.open;
    let statCalls = 0;
    fsPromise.open = async (...args) => {
      const handle = await realOpen(...args);
      const realStat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => {
        statCalls++;
        if (statCalls === 2) { // before/after 对比之间对同一隔离文件做真实 utimes(+5s)，再走原 realStat —— production reader 不变
          await fsPromise.utimes(file, new Date(originalMtimeMs + 5000), new Date(originalMtimeMs + 5000));
        }
        return realStat(...statArgs);
      };
      return handle;
    };
    try {
      await assert.rejects(core.readResourceLeaseRegistrySecure(file), /变化/);
      assert.ok(statCalls >= 2, '读取前后两次stat必须都发生（变更发生在读取中）');
      assert.ok(Math.abs(fs.statSync(file).mtimeMs - (Math.round(originalMtimeMs) + 5000)) <= 1, '文件mtime必须被真实修改（容忍Date/文件系统亚毫秒精度差）');
    } finally { fsPromise.open = realOpen; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R62 v1批次锁等待期间被其他窗口接管：每轮持有证明必须拒绝，不按取消或损坏文案', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot()); // LIVE+unknown → gate 持续轮询等待
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await gate.begin(world.dir);
  const wait = gate.wait(controller.signal);
  try {
    await latch.first;
    fs.writeFileSync(world.leasePath, JSON.stringify({ windowId: 'other-host:99999:takeover', expiresAt: new Date(Date.now() + 600000).toISOString() }), 'utf8');
    const settled = await settleWithin(wait, 3000);
    assert.equal(settled.state, 'rejected', '锁被接管后必须在下一持有证明轮拒绝（r19曾删掉每轮assertHeld，R62恢复）');
    assert.doesNotMatch(String(settled.error && settled.error.message), /test-window-end|损坏|无效/);
  } finally { controller.abort(Error('cleanup')); await settleWithin(wait, 1000); await gate.end().catch(() => undefined); }
});

test('R57 批量探测去重+数值排序且一次覆盖全部候选（与目录随机顺序无关）', async t => {
  const world = makeWorld(t);
  for (const pid of [31338, 31337, 31338]) writeRegistry(world, legacyRoot({ windowId: 'testhost:' + pid + ':aaaaaaaa-0000-0000-0000-00000000000' + String(pid).slice(-1) }));
  let calls = 0; const seen = [];
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async (pids, signal, timeoutMs) => {
    calls++; seen.push({ pids: pids.slice(), signal, timeoutMs });
    return new Map(pids.map(pid => [pid, 'unknown']));
  }, onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, 'unknown时间必须等待');
  assert.equal(calls, 1, '一次wait全程至多一次有界批量探测');
  assert.deepEqual(seen[0].pids, [31337, 31338], '必须去重并按数值升序，与随机文件名顺序无关');
  assert.equal(seen[0].signal && seen[0].signal.aborted, true, '取消必须传播到探测信号');
});

test('R55 探测超时=min(8s,剩余预算)且不扩张总预算；外按原reason及时结算', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const controller = newAbort();
  let probed = null;
  let markEntered; const probeEntered = new Promise(resolve => { markEntered = resolve; }); // R56：probeEntered闩，不定时盲等
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: (pids, signal, timeoutMs) => new Promise((resolve, reject) => {
    probed = { pids: pids.slice(), timeoutMs }; markEntered();
    const abort = () => reject(signal.reason); // 模拟随外中止的探测
    signal.addEventListener('abort', abort, { once: true });
  }) });
  const wait = gate.wait(controller.signal);
  try {
    assert.equal((await settleWithin(probeEntered, 4000)).state, 'resolved', '探测进入闩必须触发');
    assert.ok(probed.timeoutMs > 0 && probed.timeoutMs <= 8000, '探测超时必须为正且不超过8s预算帽（且≤剩余300s预算）: ' + probed.timeoutMs);
    controller.abort(Error('late-cancel'));
    const settled = await settleWithin(wait, 3000);
    assert.equal(settled.state, 'rejected', '取消必须让挂起探测路径及时结算');
    assert.match(String(settled.error && settled.error.message), /late-cancel/, '必须按原reason结算，不得被catch吞成unknown后再拖250ms');
  } finally { controller.abort(Error('cleanup')); await settleWithin(wait, 1000); }
});

test('批量探测抛异常：按unknown继续等待，异常不吞放行也不外溢掩盖中止', async t => {
  const world = makeWorld(t);
  writeRegistry(world, legacyRoot());
  const latch = pollLatch(), controller = newAbort();
  let probeErrorVisible = false;
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async () => { throw Error('probe exploded'); }, onPoll: latch.onPoll });
  const wait = gate.wait(controller.signal);
  try {
    await latch.first;
    const early = await settleWithin(wait, 30);
    assert.equal(early.state, 'pending', '探测异常=unknown，必须继续等待');
    if (early.state === 'rejected') { probeErrorVisible = true; }
    controller.abort(Error('test-window-end'));
    const settled = await settleWithin(wait, 3000);
    assert.equal(settled.state, 'rejected');
    assert.match(String(settled.error && settled.error.message), /test-window-end/, '探测内部异常不得冒充wait失败');
  } finally { if (probeErrorVisible) throw Error('探测异常外溢成了wait失败'); }
});

test('R53 孤ownership侧车并入扫描（与manager不同，gate只读更保守）：活跃活主必须等待', async t => {
  const world = makeWorld(t);
  const row = legacyRoot(); row.leases = [legacyLease(31337, row.windowId, T0)];
  const file = registryFile(world, row);
  writeRaw(world, file + '.ownership', JSON.stringify(row)); // 主槽缺失，仅剩活跃孤侧车
  const latch = pollLatch(), controller = newAbort();
  const gate = new UpdateGate(world.leasePath, LIVE, { processStartTimes: async pids => new Map(pids.map(p => [p, 'unknown'])), onPoll: latch.onPoll });
  await assertWaitsThenCancel(gate.wait(controller.signal), latch, controller, '活跃/未知孤侧车必须等待——r17修正此前"忽略孤侧车"的错误断言');
});

test('R53 孤侧车其余安全语义：死主可信可过、损坏孤侧车必须拒绝、writing与无关名仍忽略', async t => {
  const worldA = makeWorld(t);
  const idle = legacyRoot();
  const fileA = registryFile(worldA, idle);
  writeRaw(worldA, fileA + '.ownership', JSON.stringify(idle));
  writeRaw(worldA, path.join(worldA.dir, 'notaregistry.json'), '{"schemaVersion":2,');
  writeRaw(worldA, path.join(worldA.dir, 'f'.repeat(64) + '.json.writing'), 'partial');
  const deadResult = await settleWithin(new UpdateGate(worldA.leasePath, DEAD).wait(), 1500);
  assert.equal(deadResult.state, 'resolved', '死主可信孤侧车可过；.writing与无关名不构成声明');
  const worldB = makeWorld(t);
  const fileB = registryFile(worldB, legacyRoot());
  writeRaw(worldB, fileB + '.ownership', 'garbage-orphan');
  const corrupt = await settleWithin(new UpdateGate(worldB.leasePath, DEAD).wait(), 1500);
  assert.equal(corrupt.state, 'rejected', '损坏孤侧车必须拒绝');
  assert.match(String(corrupt.error && corrupt.error.message), /无法核实/);
});

test('主记录损坏+侧车可用：按可信侧车判定，死主放行', async t => {
  const world = makeWorld(t);
  const row = legacyRoot();
  const file = registryFile(world, row);
  writeRaw(world, file, '{truncated');
  writeRaw(world, file + '.ownership', JSON.stringify(row));
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'resolved', '与manager rows()等价的侧车恢复语义');
});

test('主记录损坏+无侧车：显式拒绝"无法核实"，绝不静默跳过', async t => {
  const world = makeWorld(t);
  const file = registryFile(world, legacyRoot());
  writeRaw(world, file, '{"schemaVersion":2,');
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected');
  assert.match(String(result.error && result.error.message), /无法核实/);
});

test('主+侧车双损坏：拒绝且记录原样保留', async t => {
  const world = makeWorld(t);
  const file = registryFile(world, legacyRoot());
  writeRaw(world, file, 'garbage-main'); writeRaw(world, file + '.ownership', 'garbage-side');
  const before = snapshot(world.dir);
  const result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected');
  assert.match(String(result.error && result.error.message), /无法核实/);
  assert.deepEqual(snapshot(world.dir), before, '拒绝路径不得改写或删除任何记录');
});

test('R56 安全reader边界经gate真实断言：symlink/多硬链/超8MiB全部拒绝且不动原文件', async t => {
  const world = makeWorld(t);
  const real = writeRegistry(world, legacyRoot());
  fs.renameSync(real, real + '.real');
  // R61 平台说明：无提权 Windows 禁止创建 file symlink（EPERM）。junction 只作用于目录、对文件槽
  // （O_NOFOLLOW 仅约束最终组件）不产生同语义，故 Windows 退级为"非正规文件槽"夹具（目录），
  // 安全 reader 对 open(EISDIR/EPERM) 同样必须拒绝——拒绝语义等价，如实注明。
  let slotFixture = 'symlink';
  try { fs.symlinkSync(real + '.real', real); }
  catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'ENOTDIR')) { slotFixture = 'directory-slot'; fs.mkdirSync(real); }
    else throw error;
  }
  let result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected', (slotFixture === 'symlink' ? '符号链接' : '目录占位槽') + '主槽必须拒绝（无法核实）');
  assert.match(String(result.error && result.error.message), /无法核实/);
  if (slotFixture === 'symlink') fs.rmSync(real); else fs.rmSync(real, { recursive: true });
  writeRegistry(world, legacyRoot()); // 覆盖为普通文件后再加硬链
  const plain = fs.readdirSync(world.dir).find(n => /^[0-9a-f]{64}\.json$/.test(n));
  fs.linkSync(path.join(world.dir, plain), path.join(world.dir, 'side-not-scanned')); // 硬链对侧名不被扫描，主槽 nlink=2 必须被拒
  result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected', 'nlink>1 记录必须拒绝');
  fs.rmSync(path.join(world.dir, 'side-not-scanned'));
  const big = registryFile(world, legacyRoot());
  const row = JSON.stringify(legacyRoot());
  fs.writeFileSync(big, row + ' '.repeat(8 * 1024 * 1024 - Buffer.byteLength(row) + 16), 'utf8'); // 前缀合法但超8MiB
  result = await settleWithin(new UpdateGate(world.leasePath, DEAD).wait(), 1500);
  assert.equal(result.state, 'rejected', '超过8MiB上限必须拒绝');
  // 读取中真实变更由本文件"R61 secure reader 读取中真实变更"专例直测覆盖（r20，纠正 r17 误称的 ReadOnlyView 覆盖）。
});

test('兼容判定全程只读：目录内所有租约文件字节不变（直接await，不吞错）', async t => {
  const world = makeWorld(t);
  const idle = legacyRoot(); const crashed = legacyRoot({ windowId: 'testhost:31338:aaaaaaaa-0000-0000-0000-000000000001', choosing: true, admissionExpiresAt: T0 + 30000 });
  const withLease = legacyRoot({ windowId: 'testhost:31339:aaaaaaaa-0000-0000-0000-000000000002' });
  withLease.leases = [legacyLease(31339, withLease.windowId, T0)];
  writeRegistry(world, idle); writeRegistry(world, crashed); writeRegistry(world, withLease);
  const before = snapshot(world.dir);
  await new UpdateGate(world.leasePath, DEAD).wait(); // 守卫直接await：任何抛错都让测试真红
  assert.deepEqual(snapshot(world.dir), before, '更新gate任何兼容/等待路径都不得改写、删除或触碰用户租约文件');
});
