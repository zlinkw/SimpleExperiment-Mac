const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractFrozenArray(name) {
  const start = panel.indexOf(`const ${name} = Object.freeze([`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf("]);", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 3);
}

test("frequent UI lookup paths reuse fixed command sets", () => {
  for (const constant of ["BUTTON_AUDIT_ROW_ACTION_COMMANDS", "RESOURCE_TREE_SECTION_KEYS", "PINNED_COMMAND_VALUES", "SIMPLE_SFTP_GATED_COMMANDS", "HUB_HEALTHY_STATUS_TOKENS", "OVERVIEW_HEALTHY_STATUS_TOKENS", "HUB_OPERATION_READY_STATUS_TOKENS", "TASK_CONTROL_COMMANDS", "ARTIFACT_SCOPE_COMMANDS", "PLAN_PREFLIGHT_COMMANDS", "SELECTED_PLAN_RUN_COMMANDS", "SELECTED_PLAN_ACTION_COMMANDS", "PLAN_FILE_PAYLOAD_COMMANDS", "RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS", "REALTIME_SIGNAL_STATUS_TOKENS", "REMOTE_ACTION_DISCONNECTED_HEALTH_STATES", "NO_HUB_TOPOLOGY_MODES"]) {
    assert.equal((panel.match(new RegExp(`const ${constant} = new Set`, "g")) || []).length, 1, constant);
  }
  const expectations = new Map([
    ["auditButtonPayloadWarnings", "BUTTON_AUDIT_ROW_ACTION_COMMANDS"],
    ["normalizeResourceTreeChildOrders", "RESOURCE_TREE_SECTION_KEYS"],
    ["normalizePinnedCommands", "PINNED_COMMAND_VALUES"],
    ["simpleSftpCommandDisableReason", "SIMPLE_SFTP_GATED_COMMANDS"],
  ]);
  for (const [name, constant] of expectations) {
    const source = extractFunction(name);
    assert.match(source, new RegExp(`${constant}\\?\\.has\\(`), name);
    assert.doesNotMatch(source, /new Set\(/, name);
  }
});

test("artifact scoped UI actions reuse one command set", () => {
  for (const name of ["contextRefreshPayloadFromButton", "traceActionDisableReason", "rowActionButton", "rowActionDisableReason", "disableReason", "payloadFromButton", "taskActionKeyForCommand"]) {
    assert.match(extractFunction(name), /ARTIFACT_SCOPE_COMMANDS\??\.has\(command\)/, name);
  }
  assert.doesNotMatch(panel, /\["archiveArtifacts", "deleteArtifacts"\]\.includes\(command\)/);
});

test("Plan execution checks reuse selected and submitted run command sets", () => {
  const disabled = extractFunction("disableReason");
  assert.match(panel, /const SUBMITTED_RUN_COMMANDS = new Set\(\[\.\.\.SELECTED_PLAN_RUN_COMMANDS, "runAllPlans"\]\)/);
  assert.equal((disabled.match(/SELECTED_PLAN_RUN_COMMANDS\??\.has\(command\)/g) || []).length, 2);
  assert.equal((disabled.match(/SUBMITTED_RUN_COMMANDS\??\.has\(command\)/g) || []).length, 3);
  assert.match(extractFunction("runModeForButton"), /SELECTED_PLAN_RUN_COMMANDS\??\.has\(String\(command \|\| ""\)\)/);
  assert.doesNotMatch(panel, /\["runPlan", "reproducePlan"\]\.includes\(/);
  assert.doesNotMatch(panel, /\["runPlan", "reproducePlan", "runAllPlans"\]\.includes\(/);
});

test("task control checks reuse one fixed command set", () => {
  assert.match(extractFunction("rowActionDisableReason"), /TASK_CONTROL_COMMANDS\??\.has\(command\)/);
  assert.match(extractFunction("disableReason"), /TASK_CONTROL_COMMANDS\??\.has\(command\)/);
  assert.doesNotMatch(panel, /\["stopExperiment", "retryExperiment"\]\.includes\(command\)/);
});

test("selected Plan prerequisites reuse composed command sets", () => {
  const disabled = extractFunction("disableReason");
  assert.match(panel, /const SELECTED_PLAN_ACTION_COMMANDS = new Set\(\[\.\.\.PLAN_PREFLIGHT_COMMANDS, \.\.\.SELECTED_PLAN_RUN_COMMANDS\]\)/);
  assert.match(disabled, /SELECTED_PLAN_ACTION_COMMANDS\??\.has\(command\)/);
  assert.match(disabled, /PLAN_PREFLIGHT_COMMANDS\??\.has\(command\)/);
  assert.doesNotMatch(disabled, /\["validatePlan", "dryRunPlan", "runPlan", "reproducePlan"\]\.includes/);
  assert.doesNotMatch(disabled, /\["validatePlan", "dryRunPlan"\]\.includes/);
});

test("Plan payload builders reuse base and restore-aware command sets", () => {
  assert.match(panel, /const PLAN_FILE_PAYLOAD_COMMANDS = new Set\(\[\.\.\.SELECTED_PLAN_ACTION_COMMANDS, "archivePlan", "archivePlanCopy", "savePlan"\]\)/);
  assert.match(panel, /const RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS = new Set\(\[\.\.\.PLAN_FILE_PAYLOAD_COMMANDS, "restoreArchivedPlan"\]\)/);
  assert.match(extractFunction("contextRefreshPayloadFromButton"), /PLAN_FILE_PAYLOAD_COMMANDS\??\.has\(command\)/);
  assert.match(extractFunction("payloadFromButton"), /RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS\??\.has\(command\)/);
});

test("Hub health summaries reuse composed status sets", () => {
  assert.match(panel, /const OVERVIEW_HEALTHY_STATUS_TOKENS = new Set\(\[\.\.\.HUB_HEALTHY_STATUS_TOKENS, "online"\]\)/);
  assert.match(panel, /const HUB_OPERATION_READY_STATUS_TOKENS = new Set\(\[\.\.\.HUB_HEALTHY_STATUS_TOKENS, "file_api_unavailable"\]\)/);
  assert.match(extractFunction("overviewHealthText"), /OVERVIEW_HEALTHY_STATUS_TOKENS\??\.has\(health\)/);
  assert.match(extractFunction("projectEndpointReadiness"), /HUB_OPERATION_READY_STATUS_TOKENS\??\.has\(hubStatus\)/);
});

test("Plan mode labels reuse backend-aligned alias sets", () => {
  assert.match(panel, /const PLAN_TRAIN_MODE_TOKENS = new Set\(\["train", "training", "train_only"\]\)/);
  assert.match(panel, /const PLAN_TEST_MODE_TOKENS = new Set\(\["test", "eval", "evaluate", "evaluation", "test_only", "eval_only"\]\)/);
  const source = extractFunction("planModeLabel");
  assert.match(source, /PLAN_TRAIN_MODE_TOKENS\??\.has\(value\)/);
  assert.match(source, /PLAN_TEST_MODE_TOKENS\??\.has\(value\)/);
  assert.doesNotMatch(source, /\.includes\(value\)/);
});

test("sync readiness reuses one fixed non-ready status set", () => {
  assert.match(panel, /const SYNC_NOT_READY_STATUS_TOKENS = new Set\(\["-", "待同步", "pending", "running", "in_progress", "unknown", "同步中", "执行中", "已跳过", "未参与本次同步"\]\)/);
  const source = extractFunction("syncStatusOk");
  assert.match(source, /SYNC_NOT_READY_STATUS_TOKENS\??\.has\(text\)/);
  assert.doesNotMatch(source, /\["-", "待同步"/);

  const sandbox = {
    SYNC_NOT_READY_STATUS_TOKENS: new Set(["-", "待同步", "pending", "running", "in_progress", "unknown", "同步中", "执行中", "已跳过", "未参与本次同步"]),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.syncStatusOk = syncStatusOk;`, sandbox);
  for (const value of ["", "pending", "执行中", "failed", "error", "未参与", "skipped"]) assert.equal(sandbox.syncStatusOk(value), false, value);
  for (const value of ["ok", "ready", "synced", "completed"]) assert.equal(sandbox.syncStatusOk(value), true, value);
});

test("realtime signal checks reuse one fixed status set", () => {
  assert.match(panel, /const REALTIME_SIGNAL_STATUS_TOKENS = new Set\(\["websocket", "sse", "polling", "mixed"\]\)/);
  const source = extractFunction("hasRealtimeSignal");
  assert.match(source, /REALTIME_SIGNAL_STATUS_TOKENS\??\.has\(status\)/);
  assert.doesNotMatch(source, /\["websocket", "sse", "polling", "mixed"\]\.includes/);

  const sandbox = {
    REALTIME_SIGNAL_STATUS_TOKENS: new Set(["websocket", "sse", "polling", "mixed"]),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.hasRealtimeSignal = hasRealtimeSignal;`, sandbox);
  for (const streamStatus of ["websocket", "sse", "polling", "mixed"]) {
    assert.equal(sandbox.hasRealtimeSignal({ realtime: { streamStatus } }), true, streamStatus);
  }
  assert.equal(sandbox.hasRealtimeSignal({ realtime: { streamStatus: "disconnected" } }), false);
  assert.equal(sandbox.hasRealtimeSignal({ realtime: { streamStatus: "unknown" }, lastSnapshotAt: "2026-07-30T00:00:00Z" }), true);
});

test("overview status predicates reuse immutable substring tokens", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    extractFrozenArray("REALTIME_CONNECTED_STATUS_PARTS"),
    extractFrozenArray("WORKER_AVAILABLE_STATUS_PARTS"),
    extractFunction("statusContainsAny"),
    "this.api = { statusContainsAny, realtime: REALTIME_CONNECTED_STATUS_PARTS, worker: WORKER_AVAILABLE_STATUS_PARTS };",
  ].join("\n"), sandbox);

  assert.equal(Object.isFrozen(sandbox.api.realtime), true);
  assert.equal(Object.isFrozen(sandbox.api.worker), true);
  for (const value of ["websocket", "SSE_CONNECTED", "stream-connected"]) assert.equal(sandbox.api.statusContainsAny(value, sandbox.api.realtime), true, value);
  assert.equal(sandbox.api.statusContainsAny("polling", sandbox.api.realtime), false);
  for (const value of ["agent_ok", "ONLINE", "worker-online-stale"]) assert.equal(sandbox.api.statusContainsAny(value, sandbox.api.worker), true, value);
  assert.equal(sandbox.api.statusContainsAny("offline", sandbox.api.worker), false);
  assert.equal(sandbox.api.statusContainsAny("unreachable", sandbox.api.worker), false);

});

test("remote action boundaries reuse fixed health and topology sets", () => {
  assert.match(panel, /const REMOTE_ACTION_DISCONNECTED_HEALTH_STATES = new Set\(\["local_port_closed", "agent_unreachable", "not_configured"\]\)/);
  assert.match(panel, /const NO_HUB_TOPOLOGY_MODES = new Set\(\["single_worker", "worker_pool"\]\)/);

  const disabled = extractFunction("disableReason");
  assert.match(disabled, /REMOTE_ACTION_DISCONNECTED_HEALTH_STATES\??\.has\(health\)/);
  assert.doesNotMatch(disabled, /\["local_port_closed", "agent_unreachable", "not_configured"\]\.includes/);

  const noHub = extractFunction("missingNoHubWorkerResultCapabilities");
  assert.match(noHub, /NO_HUB_TOPOLOGY_MODES\??\.has\(String\(topology\.mode \|\| ""\)\)/);
  assert.doesNotMatch(noHub, /\["single_worker", "worker_pool"\]\.includes/);
});
