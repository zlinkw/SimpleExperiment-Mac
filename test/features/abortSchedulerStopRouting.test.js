const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function readWithLegacyFallback(primary, legacy) {
  const p = path.join(__dirname, primary);
  const l = path.join(__dirname, legacy);
  let txt = "";
  try { txt = fs.readFileSync(p, "utf8"); } catch {}
  if (txt && txt.includes("async abortSchedulerFromUi(message") ) return txt;
  if (txt && txt.includes("def stop_scheduler_operation(") ) return txt;
  try { const lt = fs.readFileSync(l, "utf8"); if (lt && lt.length > txt.length) return lt; } catch {}
  return txt;
}
const extensionSource = readWithLegacyFallback("../../src/extension.ts", "../../src/extension/legacy.ts");
const agentSource = readWithLegacyFallback("../../src/clusterAgentRuntime.ts", "../../src/clusterAgentRuntime.legacy.ts");

test("abortSchedulerFromUi routes through stop-scheduler-operation (tmux kill + SIGTERM/SIGKILL + deregister)", () => {
  const start = extensionSource.indexOf("async abortSchedulerFromUi(message");
  const end = extensionSource.indexOf("private clearLocalOperationCachesForOp(", start);
  const body = extensionSource.slice(start, end);
  // 不再仅写控制文件 abort_cleanup / 调用 client.abortScheduler / 直连 /api/scheduler/abort
  assert.ok(!/action:\s*"abort_cleanup"/.test(body), "must not use abort_cleanup control-file path");
  assert.ok(!/client\.abortScheduler/.test(body), "must not call client.abortScheduler");
  assert.ok(!/\/api\/scheduler\/abort/.test(body), "must not hit scheduler/abort HTTP endpoint");
  // 统一走 stopExperimentRouted -> postWorkerTunnelAction stop-scheduler-operation
  assert.match(body, /stopExperimentRouted\(\{/);
  assert.match(body, /action:\s*"stop-scheduler-operation"/);
  // 依据 remainingActiveEvidence 确认清理，非空则重试并置 failed
  assert.match(body, /remainingActiveEvidence/);
  assert.match(body, /if \(remaining\.length\)\s*\{\s*const retry:[\s\S]{0,100}stopExperimentRouted\(\{/, "should retry stop when remaining evidence exists");
  assert.match(body, /result\.matchedOperations\.includes\(operationId\)/, "requires remote target confirmation");
  assert.match(body, /op\.status = "cancelled"/, "successful stop marks cancelled");
  assert.match(body, /op\.status = "failed"/, "lingering tmux marks failed");
  assert.match(body, /remainingSummary/, "failed path reports the exact returned activity identity");
  assert.doesNotMatch(body, /zlk-sch-/, "failed path does not invent a tmux prefix");
});

test("abortSchedulerFromUi clears scoped UI caches but preserves unowned temp files", () => {
  const start = extensionSource.indexOf("async abortSchedulerFromUi(message");
  const end = extensionSource.indexOf("private clearLocalOperationCachesForOp(", start);
  const body = extensionSource.slice(start, end);
  assert.match(body, /clearLocalOperationCachesForOp\(operationId\)/, "clears realtime/snapshot cache for op");
  assert.match(body, /cleanupSchedulerTmpForOp\(operationId, planFile\)/, "checks whether cleanup has a precise owner");
  assert.match(body, /调度状态保留 7 天用于排错/);
  const cleanupStart = extensionSource.indexOf("private cleanupSchedulerTmpForOp(opId: string, planFile: string)");
  const cleanupEnd = extensionSource.indexOf("async openScalarViewerFromUi", cleanupStart);
  const cleanup = extensionSource.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /新调度状态保留 7 天/);
  assert.doesNotMatch(cleanup, /unlink|rmSync|rmdir|readdirSync/);
  // clearLocalOperationCachesForOp strips only the target op from lastRealtimeState/lastSnapshot
  const helper = agentSource.length && extensionSource.slice(extensionSource.indexOf("private clearLocalOperationCachesForOp(opId"), extensionSource.indexOf("private cleanupSchedulerTmpForOp(opId"));
  assert.match(helper, /delete ops\[opId\]/, "cache helper deletes only the target opId");
  assert.match(helper, /store\.operations = ops\.filter/, "cache helper filters array-shaped operations");
});

test("normal stop forwards the clicked operation id through actionBody", () => {
  assert.match(extensionSource, /stopExperimentRouted\(\{ \.\.\.body, operationId: stringField\(message, "operationId"\)/);
  assert.match(extensionSource, /confirmed\.map\(String\)\.includes\(String\(request\.targetOperationId/);
  assert.match(extensionSource, /candidates = \[\{ operationId: target\.operationId, planFile: target\.planFile, type: "run-plan"/, "reloaded single Worker can stop an explicit remote operation");
});

test("stop-scheduler-operation handler reaps empty shells via raw session-alive", () => {
  const handler = agentSource.slice(agentSource.indexOf("def stop_scheduler_operation("), agentSource.indexOf("def recent_operations(", agentSource.indexOf("def stop_scheduler_operation(")));
  assert.match(handler, /before\["tmuxShellAlive"\]/, "kill decision uses raw shell-alive, not python-gated tmuxSessionAlive");
  assert.match(handler, /if not matched_scheduler and recorded_plan != requested_plan:[\s\S]*未清理 GPU 任务/, "unmatched stop does not clean other tasks");
  assert.match(handler, /if task_plan != requested_plan:\s*continue/, "task cleanup stays within selected Plan");
  assert.doesNotMatch(handler, /_reap_orphan_gpu_sessions\(root, force_all=True\)/);
});

test("scheduler_process_evidence reports python-gated tmuxSessionAlive plus diagnostics", () => {
  const fn = agentSource.slice(agentSource.indexOf("def scheduler_process_evidence("), agentSource.indexOf("def api_runtime_operation_evidence("));
  assert.match(fn, /_tmux_pane_python_running/);
  assert.match(fn, /"tmuxSessionAlive": tmux_alive/);
  assert.match(fn, /"tmuxShellAlive": session_alive/);
  assert.match(fn, /"tmuxPythonRunning": python_running/);
  // 空 shell（会话存活但无 python 进程）不应判 tmuxSessionAlive
  assert.match(fn, /tmux_alive = session_alive and python_running/);
});
