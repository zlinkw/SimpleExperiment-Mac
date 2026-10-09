const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

function loadRealtimeUiSignatures(source) {
  const block = source.match(/function realtimeUiFieldSignature[\s\S]*?function objectRecord/)?.[0] || "";
  const runnable = block
    .replace("function realtimeUiFieldSignature(value: unknown): string", "function realtimeUiFieldSignature(value)")
    .replace("function realtimeUiTopLevelSignature(value: Record<string, unknown>): string", "function realtimeUiTopLevelSignature(value)")
    .replace(/\nfunction objectRecord[\s\S]*$/, "");
  return new Function(runnable + "; return { field: realtimeUiFieldSignature, topLevel: realtimeUiTopLevelSignature };")();
}

test("extension coalesces webview state posts behind explicit render backpressure", () => {
  const source = readSource("src/extension.ts");
  const postStateBlock = source.match(/private postState[\s\S]*?private flushStatePost/)?.[0] || "";
  const flushBlock = source.match(/private flushStatePost[\s\S]*?private integration/)?.[0] || "";

  assert.match(source, /private statePostTimer\?: ReturnType<typeof setTimeout>/);
  assert.match(source, /private panelStateFlow = PanelStateFlowControl_1\.createPanelStateFlowControlState\(\)/);
  assert.match(source, /private lastPostedStateSignature = ""/);
  assert.match(source, /requestPanelStateFlowPost\(this\.panelStateFlow, immediate, bootstrap\)/);
  assert.match(postStateBlock, /decision\.reason === "awaiting-render"/);
  assert.match(postStateBlock, /decision\.reason === "hidden"/);
  assert.match(source, /resolveWebviewView\(webviewView\)[\s\S]{0,1400}this\.loadPanelHtml\(\)/);
  assert.match(source, /renderPanelBootstrapDocument\(renderPanelHtml, renderPanelRecoveryHtml\)/);
  assert.match(postStateBlock, /if \(immediate\)[\s\S]{0,220}this\.flushStatePost\(true\)/);
  assert.match(postStateBlock, /this\.statePostTimer = setTimeout\(\(\) => this\.flushStatePost\(false\), delayMs\)/);
  assert.match(flushBlock, /this\.panelStateFlow\.outstandingRenderSeq !== null && this\.panelStateFlow\.renderedSeq < this\.panelStateFlow\.outstandingRenderSeq/);
  assert.match(flushBlock, /if \(!this\.webviewDocumentVisible \|\| !this\.view\.visible\)/);
  assert.match(flushBlock, /try \{\s*state = this\.buildState\(\{ panelProjection: true \}\)/);
  assert.match(flushBlock, /catch \(error\)[\s\S]{0,700}this\.buildPanelFallbackState\(this\.lastError\)/);
  assert.match(source, /private buildPanelFallbackState\(message: string\): WebviewClusterState/);
  assert.match(flushBlock, /state\.contextActionSignature = contextActionStatePostSignature\(state\)/);
  assert.match(flushBlock, /const signature = webviewStatePostSignature\(state\)/);
  assert.match(flushBlock, /if \(!force && signature === this\.lastPostedStateSignature\)/);
  assert.match(flushBlock, /if \(!delivered\)[\s\S]{0,180}reportPostError/);
  assert.match(flushBlock, /this\.lastPostedStateSignature = signature/);
  assert.match(flushBlock, /postMessageWithTimeout\(\(\) => targetView\.webview\.postMessage\(stateMessage\), this\.statePostDeliveryTimeoutMs\)/);
  assert.match(flushBlock, /markPanelStateFlowPosted\(this\.panelStateFlow, stateSeq, Date\.now\(\)\)/);
  assert.match(flushBlock, /maxOutstandingFullStates = Math\.max\(this\.maxOutstandingFullStates[\s\S]{0,140}1\)/);
  assert.match(flushBlock, /catch \(error\) \{\s*reportPostError\(error\)/);
  assert.match(source, /function webviewStatePostSignature\(state: WebviewClusterState\): string/);
  assert.match(source, /return realtimeUiTopLevelSignature\(state\)/);
  const contextActionSignatureBlock = source.match(/function contextActionStatePostSignature[\s\S]*?function realtimeUiFieldSignature/)?.[0] || "";
  for (const field of ["setup", "integrations", "health", "realtime", "capabilities", "selection", "workerProbes", "plans", "schedulerStates", "operations", "resultsSummary"]) {
    assert.match(contextActionSignatureBlock, new RegExp(`${field}: state\\.${field}`));
  }
  for (const field of ["gpu", "gpuHistory", "logs", "fileTransfers", "diagnostics", "auditTail"]) {
    assert.doesNotMatch(contextActionSignatureBlock, new RegExp(`state\\.${field}`));
  }
  assert.doesNotMatch(postStateBlock, /postMessage\(\{ type: "state"/);
  assert.match(flushBlock, /let serializedMessage = JSON\.stringify\(stateMessage\)/);
  assert.match(flushBlock, /scanSerializedPanelState\(serializedMessage, payloadBytes\)/);
});

test("extension skips heartbeat-only realtime webview posts and keeps content changes", () => {
  const source = readSource("src/extension.ts");
  const createClientBlock = source.match(/private createClient\(\): MultiEndpointRealtimeClient[\s\S]*?private shouldPushLocalAvailabilityFromRealtime/)?.[0] || "";
  const postGateBlock = source.match(/private shouldPostRealtimeStateForWebview[\s\S]*?private realtimeUiStateRefsFor/)?.[0] || "";
  const refsBlock = source.match(/private realtimeUiStateRefsFor[\s\S]*?private realtimeRefreshPolicy/)?.[0] || "";

  assert.match(source, /private realtimeUiStateRefs\?: RealtimeUiStateRefs/);
  assert.match(source, /private lastRealtimeHeartbeatPostAt = 0/);
  assert.match(source, /private readonly realtimeHeartbeatPostMinMs = 60_000/);
  assert.match(source, /private lastAvailabilityGpuSignature = ""/);
  assert.match(source, /function realtimeUiFieldSignature\(value: unknown\): string/);
  assert.match(source, /function realtimeUiStableHash\(value, depth, digest\)/);
  assert.doesNotMatch(source, /function realtimeUiStableText/);
  assert.match(createClientBlock, /const uiRefs = this\.realtimeUiStateRefsFor\(state\)/);
  assert.equal((createClientBlock.match(/realtimeUiStateRefsFor\(state\)/g) || []).length, 1);
  assert.match(createClientBlock, /if \(this\.shouldPushLocalAvailabilityFromRealtime\(uiRefs\.gpu\)\) void this\.pushLocalWorkerAvailability\(false\)/);
  assert.match(createClientBlock, /if \(this\.shouldPostRealtimeStateForWebview\(uiRefs\)\) this\.postState\(\)/);
  for (const field of ["gpu", "schedulerStates", "experimentTraces", "logs", "operations", "diagnostics", "fileTransfers", "workerHealth", "workerTasks", "warnings"]) {
    assert.match(postGateBlock, new RegExp(`previous\\.${field} !== nextRefs\\.${field}`));
    assert.match(refsBlock, new RegExp(`${field}: realtimeUiFieldSignature\\(state\\.${field}\\)`));
    assert.doesNotMatch(refsBlock, new RegExp(`${field}: state\\.${field}[,\\n]`));
  }
  assert.match(postGateBlock, /previous\.resultSummaryDirtyKey !== nextRefs\.resultSummaryDirtyKey/);
  assert.match(postGateBlock, /nowMs - this\.lastRealtimeHeartbeatPostAt < this\.realtimeHeartbeatPostMinMs/);
  assert.match(source, /private shouldPushLocalAvailabilityFromRealtime\(signature\)/);
  assert.doesNotMatch(source, /private shouldPushLocalAvailabilityFromRealtime[\s\S]{0,160}realtimeUiFieldSignature/);
  assert.match(source, /this\.lastAvailabilityGpuSignature === signature/);
  assert.doesNotMatch(source, /lastAvailabilityGpuRef/);
});

test("realtime state signatures stay bounded and sample across large values", () => {
  const source = readSource("src/extension.ts");
  const { field: signature, topLevel } = loadRealtimeUiSignatures(source);
  assert.equal(signature({ b: 2, a: 1 }), signature({ a: 1, b: 2 }));

  const longA = "a".repeat(600);
  const longB = longA.slice(0, 300) + "b" + longA.slice(301);
  assert.notEqual(signature(longA), signature(longB));

  const rowsA = Array.from({ length: 600 }, (_, index) => ({ index, value: "same" }));
  const rowsB = rowsA.map((row) => ({ ...row }));
  rowsB[599].value = "changed";
  assert.notEqual(signature(rowsA), signature(rowsB));

  const deepA = { a: { b: { c: { d: { e: { f: "before" } } } } } };
  const deepB = { a: { b: { c: { d: { e: { f: "after" } } } } } };
  assert.notEqual(signature(deepA), signature(deepB));

  const dense = Array.from({ length: 240 }, (_, outer) => Array.from({ length: 240 }, (_, inner) => outer * 240 + inner));
  const nodeCount = Number(signature(dense).split(":")[2]);
  assert.equal(nodeCount, 4096);

  const saturated = Array.from({ length: 240 }, (_, outer) => Array.from({ length: 240 }, (_, inner) => outer * 240 + inner));
  assert.notEqual(topLevel({ a: saturated, z: "before" }), topLevel({ a: saturated, z: "after" }));
});

test("local availability push stays server-only and project-state-free", () => {
  const source = readSource("src/extension.ts");
  const loopStart = source.indexOf("\n    startAvailabilityPushLoop() {");
  assert.ok(loopStart >= 0);
  const loopBlock = source.slice(loopStart, source.indexOf("\n    availabilityPushMinIntervalMs(", loopStart));
  const pushBlock = source.match(/private async pushLocalWorkerAvailability[\s\S]*?private localWorkerAvailabilityRows/)?.[0] || "";
  const rowsBlock = source.match(/private localWorkerAvailabilityRows[\s\S]*?private resetClient/)?.[0] || "";

  assert.match(source, /private availabilityPushLoopGeneration = 0/);
  assert.match(loopBlock, /const loopGeneration = \+\+this\.availabilityPushLoopGeneration/);
  assert.match(loopBlock, /if \(loopGeneration !== this\.availabilityPushLoopGeneration\)\s*return/);
  assert.match(loopBlock, /if \(this\.availabilityPushTimer === timer\)\s*this\.availabilityPushTimer = undefined/);
  assert.match(loopBlock, /if \(loopGeneration === this\.availabilityPushLoopGeneration\)\s*scheduleNext\(\)/);
  assert.doesNotMatch(loopBlock, /finally\(scheduleNext\)/);
  const dispose = source.slice(source.indexOf("async dispose()"), source.indexOf("startAvailabilityPushLoop()", source.indexOf("async dispose()")));
  assert.match(dispose, /this\.availabilityPushLoopGeneration \+= 1;[\s\S]{0,160}clearTimeout\(this\.availabilityPushTimer\)/);
  assert.match(pushBlock, /const generation = this\.projectContextGeneration/);
  assert.match(pushBlock, /const client = this\.client/);
  assert.match(pushBlock, /client\.postAvailabilityBatch/);
  assert.match(pushBlock, /if \(generation === this\.projectContextGeneration && client === this\.client\)\s*this\.lastError = errorMessage\(error\)/);
  assert.match(pushBlock, /source: "local_aggregator"/);
  assert.match(pushBlock, /workers,/);
  for (const forbidden of ["plan", "recentPlans", "resultsSummary", "fileTransfers", "projectRoot", "workspaceState", "globalState"]) {
    assert.doesNotMatch(pushBlock, new RegExp(forbidden), forbidden);
    assert.doesNotMatch(rowsBlock, new RegExp(forbidden), forbidden);
  }
  for (const allowed of ["workerId", "availableGpuIds", "busyGpuIds", "capacityLimit", "ttlSeconds"]) {
    assert.match(rowsBlock, new RegExp(allowed), allowed);
  }
});

test("UI command wrapper has no total watchdog and posts the real terminal outcome", () => {
  const source = readSource("src/extension.ts");
  const block = source.match(/private async withUiCommandStatus[\s\S]*?private postUiCommandStatus/)?.[0] || "";
  const watchdog = source.slice(source.indexOf("uiCommandWatchdogMs(command)"), source.indexOf("private postUiCommandStatus", source.indexOf("uiCommandWatchdogMs(command)")));
  assert.match(watchdog, /return 0/);
  assert.match(block, /const result: any = await guardedWork/);
  assert.match(block, /if \(!statusPosted\) this\.postUiCommandStatus\(clientActionId, result\.status, command, result\.message/);
});
