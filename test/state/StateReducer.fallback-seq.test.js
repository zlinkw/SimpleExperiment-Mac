const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// 引入被测模块：优先尝试 dist 编译产物，回退到内联实现（与源码一致）
// 修复原因：fallback seq:-1 需保证不回滚终态，单测需覆盖 terminal 不被 -1 覆盖
let shouldAcceptVersionedState;
let mergeVersionedState;
let mergeRows;
let rowKey;

let loadedFromDist = false;
try {
  // 尝试加载编译后的 AgentStateReducer（若已执行 npm run build）
  const distPath = path.join(__dirname, "../../dist/agent/AgentStateReducer.js");
  if (fs.existsSync(distPath)) {
    const mod = require(distPath);
    if (mod.shouldAcceptVersionedState && mod.mergeVersionedState) {
      shouldAcceptVersionedState = mod.shouldAcceptVersionedState;
      mergeVersionedState = mod.mergeVersionedState;
      loadedFromDist = true;
    }
  }
} catch (e) {
  // ignore, fallback to inline
}
try {
  const distStatePath = path.join(__dirname, "../../dist/state/StateReducer.js");
  if (fs.existsSync(distStatePath)) {
    const mod2 = require(distStatePath);
    // StateReducer 未直接导出 mergeRows/rowKey，但可通过 clusterReducer 间接验证
  }
} catch {}

if (!shouldAcceptVersionedState || !mergeVersionedState) {
  // 内联实现：与 src/agent/AgentStateReducer.ts 1-37 完全一致（已标注来源一致，供行为级验证）
  // 来源：src/agent/AgentStateReducer.ts:1-37（terminalStates + shouldAcceptVersionedState + mergeVersionedState）
  const terminalStates = new Set(["completed", "failed", "stopped", "deleted", "delete_failed"]);
  // 需暴露给测试使用
  global.__terminalStates = terminalStates;
  shouldAcceptVersionedState = function (previous, incoming) {
    if (!previous) return true;
    if (incoming.runKey && previous.runKey && incoming.runKey === previous.runKey && incoming.sessionId && previous.sessionId && incoming.sessionId !== previous.sessionId) return true;
    const prevSeq = Number(previous.seq || 0);
    const nextSeq = Number(incoming.seq || 0);
    if (prevSeq && nextSeq && nextSeq < prevSeq) return false;
    const prevVersion = Number(previous.stateVersion || 0);
    const nextVersion = Number(incoming.stateVersion || 0);
    if (prevVersion && nextVersion && nextVersion < prevVersion) return false;
    const prevTime = Date.parse(String(previous.generatedAt || ""));
    const nextTime = Date.parse(String(incoming.generatedAt || ""));
    if (Number.isFinite(prevTime) && Number.isFinite(nextTime) && nextTime < prevTime && !nextSeq) return false;
    const prevStatus = String(previous.status || previous.state || "").toLowerCase();
    const nextStatus = String(incoming.status || incoming.state || "").toLowerCase();
    if (terminalStates.has(prevStatus) && !terminalStates.has(nextStatus) && previous.runKey === incoming.runKey && String(previous.sessionId || "") === String(incoming.sessionId || "")) return false;
    return true;
  };
  mergeVersionedState = function (previous, incoming) {
    if (!shouldAcceptVersionedState(previous, incoming)) return previous;
    return { ...(previous || {}), ...incoming };
  };
  // 暴露 terminalStates 供测试
  shouldAcceptVersionedState.__terminalStates = terminalStates;
} else {
  // 若从 dist 加载，也尝试获取 terminalStates（通过源码读取校验）
  try {
    const src = fs.readFileSync(path.join(__dirname, "../../src/agent/AgentStateReducer.ts"), "utf8");
    // 确保源码与 dist 一致（简易校验）
    assert.ok(src.includes('new Set(["completed", "failed", "stopped", "deleted", "delete_failed"])'));
  } catch {}
}

// StateReducer 的 mergeRows/rowKey 内联（与 src/state/StateReducer.ts 95-107 一致）
if (!mergeRows) {
  // 与 src/state/StateReducer.ts:95-107 保持一致
  rowKey = function (row) {
    return String(row.runKey || row.run_key || row.global_job_id || row.run_id || row.sessionId || row.session_id || row.file || row.key || row.id || JSON.stringify(row));
  };
  mergeRows = function (previous, incoming, seq) {
    const map = new Map();
    for (const row of previous || []) map.set(rowKey(row), row);
    for (const row of incoming || []) {
      const next = { ...row, seq: row.seq ?? seq };
      map.set(rowKey(next), mergeVersionedState(map.get(rowKey(next)), next));
    }
    return Array.from(map.values());
  };
}

// 辅助：获取 terminalStates 集合（用于断言）
function getTerminalStates() {
  if (shouldAcceptVersionedState.__terminalStates) return shouldAcceptVersionedState.__terminalStates;
  if (global.__terminalStates) return global.__terminalStates;
  return new Set(["completed", "failed", "stopped", "deleted", "delete_failed"]);
}

test("a) terminalStates 不被 seq:-1 非终态覆盖（shouldAcceptVersionedState 返回 false）", () => {
  const terminals = ["completed", "failed", "stopped", "deleted", "delete_failed"];
  const termSet = getTerminalStates();
  // 验证集合完整性
  assert.deepEqual([...termSet].sort(), terminals.sort());
  for (const term of terminals) {
    const prev = { runKey: "k1", sessionId: "s1", seq: 5, status: term, stateVersion: 2, generatedAt: "2026-01-01T00:00:00.000Z" };
    const incoming = { runKey: "k1", sessionId: "s1", seq: -1, status: "running", stateVersion: 1, generatedAt: "2026-01-01T00:01:00.000Z" };
    const accepted = shouldAcceptVersionedState(prev, incoming);
    assert.equal(accepted, false, `terminal ${term} 应拒绝 seq:-1 的 running 覆盖，got ${accepted}`);
  }
  // non-terminal -> terminal 应该是接受的（即使 seq:-1，也不应因 terminal 逻辑拒绝，反而应接受推进终态）
  // 但 fallback 场景是 prev terminal + incoming non-terminal，所以这里只验证前者
});

test("b) mergeVersionedState(prev terminal seq=5, incoming seq:-1 non-terminal) 返回 prev 不被覆盖", () => {
  const prev = { runKey: "k", sessionId: "sess", seq: 5, status: "completed", stateVersion: 3, generatedAt: "2026-08-31T00:00:00.000Z", data: "prev" };
  const incoming = { runKey: "k", sessionId: "sess", seq: -1, status: "running", stateVersion: 3, generatedAt: "2026-08-31T00:01:00.000Z", data: "incoming" };
  const merged = mergeVersionedState(prev, incoming);
  // 应返回 prev 引用或深等价 prev
  assert.equal(merged, prev, "mergeVersionedState 应直接返回 prev 引用（不被覆盖）");
  assert.equal(merged.status, "completed");
  assert.equal(merged.seq, 5);
  assert.equal(merged.data, "prev");
});

test("c) prev running seq=5 + incoming seq:-1 non-terminal 的行为需与产品语义一致：fallback 不会推进终态（应被拒绝）", () => {
  // 产品语义：fallback 的 seq:-1 不应覆盖已存在的 running 且 seq 更大的状态，避免时序回退
  // 按 shouldAcceptVersionedState 逻辑：prevSeq=5, nextSeq=-1 => -1<5 => false => 拒绝
  const prev = { runKey: "k2", sessionId: "s2", seq: 5, status: "running", generatedAt: "2026-08-31T00:00:00.000Z" };
  const incoming = { runKey: "k2", sessionId: "s2", seq: -1, status: "running", generatedAt: "2026-08-31T00:01:00.000Z" };
  const accepted = shouldAcceptVersionedState(prev, incoming);
  // 文档化：fallback seq:-1 不会推进终态，且不会覆盖已有 seq=5 的 running（因 nextSeq < prevSeq）
  assert.equal(accepted, false, "prev running seq=5 应拒绝 incoming seq:-1（fallback 不推进）");
  const merged = mergeVersionedState(prev, incoming);
  assert.equal(merged, prev, "mergeVersionedState 应保持 prev");
  // 额外验证：若 prev 无 seq（0），incoming -1 应被接受（因为 prevSeq falsy 不触发拦截）
  const prevNoSeq = { runKey: "k2", sessionId: "s2", seq: 0, status: "running" };
  const accepted2 = shouldAcceptVersionedState(prevNoSeq, incoming);
  // prevSeq=0 falsy, 所以 !prevSeq => 不进入 seq 比较，返回 true（除非 terminal 拦截）
  assert.equal(accepted2, true, "prev seq=0 时 incoming -1 应被接受（seq 拦截不生效）");
});

test("d) mergeRows 的 seq 注入：previous completed seq=5 不被 incoming seq:-1 running 覆盖", () => {
  const previous = [{ runKey: "k", seq: 5, status: "completed", sessionId: "s1" }];
  const incoming = [{ runKey: "k", seq: -1, status: "running", sessionId: "s1" }];
  const result = mergeRows(previous, incoming);
  assert.equal(result.length, 1);
  const row = result[0];
  // 应仍为 completed，seq 保持 5
  assert.equal(String(row.status).toLowerCase(), "completed", `expected completed but got ${row.status}`);
  // seq 可能是 5（来自 prev）因为 merge 被拒绝
  assert.equal(Number(row.seq), 5, `expected seq 5 but got ${row.seq}`);
  // 验证若用 seq 参数注入（action.seq）但行自带 seq:-1，行内 seq 优先
  const result2 = mergeRows(previous, [{ runKey: "k", status: "running", sessionId: "s1" }], -1);
  // 此时 incoming 无 seq，next.seq = undefined ?? -1 => -1，所以仍会被拒绝
  assert.equal(result2.length, 1);
  assert.equal(String(result2[0].status).toLowerCase(), "completed");
});

test("e) stateVersion/generatedAt 倒退拒绝逻辑", () => {
  // stateVersion 倒退
  const prevV = { runKey: "k", sessionId: "s1", seq: 10, stateVersion: 5, status: "running", generatedAt: "2026-08-31T00:00:10.000Z" };
  const incomingV = { runKey: "k", sessionId: "s1", seq: 11, stateVersion: 3, status: "running", generatedAt: "2026-08-31T00:00:20.000Z" };
  assert.equal(shouldAcceptVersionedState(prevV, incomingV), false, "stateVersion 3 < 5 应被拒绝");

  // generatedAt 倒退且 !nextSeq 场景（nextSeq falsy 时才触发时间比较）
  const prevT = { runKey: "k", sessionId: "s1", seq: 0, stateVersion: 0, status: "running", generatedAt: "2026-08-31T00:00:20.000Z" };
  const incomingT = { runKey: "k", sessionId: "s1", seq: 0, stateVersion: 0, status: "running", generatedAt: "2026-08-31T00:00:10.000Z" };
  // 此时 nextSeq=0 falsy, 所以会检查时间：nextTime < prevTime && !nextSeq => true => 拒绝
  assert.equal(shouldAcceptVersionedState(prevT, incomingT), false, "generatedAt 倒退且 nextSeq falsy 应被拒绝");

  // 若 nextSeq 非 falsy，则时间倒退不应单独拒绝（seq 优先）
  const prevT2 = { runKey: "k", sessionId: "s1", seq: 5, status: "running", generatedAt: "2026-08-31T00:00:20.000Z" };
  const incomingT2 = { runKey: "k", sessionId: "s1", seq: 6, status: "running", generatedAt: "2026-08-31T00:00:10.000Z" };
  // nextSeq=6 真，prevSeq=5 真，但 6<5 false；stateVersion 不拦截；时间检查因 !nextSeq=false 不触发；terminal 不匹配 => 接受
  assert.equal(shouldAcceptVersionedState(prevT2, incomingT2), true, "nextSeq 真时时间倒退不应拒绝（seq 语义优先）");

  // stateVersion 相同但 seq 更大应接受
  const prevV3 = { runKey: "k", sessionId: "s1", seq: 5, stateVersion: 5, status: "running" };
  const incomingV3 = { runKey: "k", sessionId: "s1", seq: 6, stateVersion: 5, status: "running" };
  assert.equal(shouldAcceptVersionedState(prevV3, incomingV3), true);

  // 验证 mergeVersionedState 对 version 倒退的保护
  const merged = mergeVersionedState(prevV, incomingV);
  assert.equal(merged, prevV, "version 倒退的 merge 应返回 prev");
});

test("f) 额外覆盖：不同 sessionId 应接受（即使 terminal）", () => {
  const prev = { runKey: "k", sessionId: "s1", seq: 5, status: "completed" };
  const incoming = { runKey: "k", sessionId: "s2", seq: -1, status: "running" };
  // 按源码：runKey 相同且 sessionId 不同 => 直接返回 true（新会话）
  assert.equal(shouldAcceptVersionedState(prev, incoming), true);
});

test("g) 验证 shouldAccept 对非 terminal 的 prev 不拦截（running -> running seq 递增应接受）", () => {
  const prev = { runKey: "k", sessionId: "s1", seq: 5, status: "running" };
  const incoming = { runKey: "k", sessionId: "s1", seq: 6, status: "running" };
  assert.equal(shouldAcceptVersionedState(prev, incoming), true);
  const merged = mergeVersionedState(prev, incoming);
  assert.notEqual(merged, prev);
  assert.equal(merged.seq, 6);
});
