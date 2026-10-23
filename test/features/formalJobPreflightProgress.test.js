const { test, assert, path, spawnSync, run } = require("./formalJobPreflightProgress.support.cjs");

test('real Worker startup accepts asset progress beyond the previous fixed ten-second budget', () => {
  const result = run('grow');
  assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
  // 资产核实归项目 hook（project_owned，运行时执行）：准入预检只做结构与身份核实，
  // 即使项目 hook 会哈希大资产，也不在准入阶段产生逐资产回调。
  assert.deepEqual(result.callbacks, []);
  assert.equal(result.receipt.startupPreflight, 'pending');
  // 取代固定十秒墙钟预算的是失速看门狗：子进程经 SIMPLE_PROGRESS stderr 进展刷新窗口，不存在固定超时误杀。
  assert.deepEqual(result.inactivityCalls, [{ progress_stream: 'stderr', file_step: false }]);
  assert.equal(result.executionStarted, false);
});
test('real Worker admission defers project asset validation for every only-index selection', () => {
  for (const variant of ['fast', 'pad']) {
    const result = run(variant);
    assert.equal(result.receipt.durableAccepted, true, JSON.stringify(result));
    assert.deepEqual(result.callbacks, []);
  }
  const shared = run('duplicate');
  assert.equal(shared.receipt.neverStarted, true);
  assert.match(shared.receipt.error || shared.receipt.message, /share one execution CSV/);
});
