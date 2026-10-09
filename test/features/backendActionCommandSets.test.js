const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function methodBody(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing method range ${startMarker}`);
  return source.slice(start, end);
}

test("backend Worker action confirmation reuses one fixed command set", () => {
  const body = methodBody("async runActionCommandCore(command, message)", "async runPlanPreflight(body, label, authority = {})");
  assert.match(source, /const WORKER_ARTIFACT_COMMANDS = new Set\(\["archiveArtifacts", "deleteArtifacts"\]\)/);
  assert.match(source, /const WORKER_ACTION_CONFIRM_COMMANDS = new Set\(\["stopExperiment", \.\.\.WORKER_ARTIFACT_COMMANDS\]\)/);
  assert.equal((body.match(/WORKER_ACTION_CONFIRM_COMMANDS\??\.has\(command\)/g) || []).length, 2);
  assert.doesNotMatch(body, /\["stopExperiment", "archiveArtifacts", "deleteArtifacts"\]\.includes\(command\)/);
  assert.match(methodBody("canFallbackTaskActionToHub(command, body, missingWorkerCapabilities)", "async postMultiWorkerTunnelAction(workerIds, action, body, options)"), /WORKER_ARTIFACT_COMMANDS\??\.has\(command\)/);
});

test("backend action routing reuses composed confirmation and scheduler sets", () => {
  const body = methodBody("async runActionCommandCore(command, message)", "async runPlanPreflight(body, label, authority = {})");
  assert.match(source, /const NO_HUB_RESULT_CONFIRM_COMMANDS = new Set\(/);
  assert.match(source, /const PLAN_PREFLIGHT_COMMANDS = new Set\(\["validatePlan", "dryRunPlan"\]\)/);
  assert.match(source, /const PLAN_SUBMISSION_COMMANDS = new Set\(\["runPlan", "reproducePlan"\]\)/);
  assert.match(source, /const PLAN_SCHEDULER_COMMANDS = new Set\(\[\.\.\.PLAN_PREFLIGHT_COMMANDS, \.\.\.PLAN_SUBMISSION_COMMANDS\]\)/);
  assert.match(source, /const TUNNEL_ACTION_CONFIRM_COMMANDS = new Set\(\["stopExperiment", "retryExperiment", \.\.\.NO_HUB_RESULT_CONFIRM_COMMANDS, "deleteArtifacts", "reconcileDeletions"\]\)/);
  for (const constant of ["NO_HUB_RESULT_CONFIRM_COMMANDS", "PLAN_PREFLIGHT_COMMANDS", "PLAN_SUBMISSION_COMMANDS", "PLAN_SCHEDULER_COMMANDS", "TUNNEL_ACTION_CONFIRM_COMMANDS"]) {
    assert.match(body, new RegExp(`${constant}\\.has\\(command\\)`), constant);
  }
  const watchdog = methodBody("uiCommandWatchdogMs(command)", "private postUiCommandStatus(clientActionId, status, command, message,");
  assert.doesNotMatch(watchdog, /return [1-9][0-9_]*;/);
  assert.match(watchdog, /return 0;/);
  assert.doesNotMatch(body, /\["archiveArtifacts", "excludeResults", "syncArtifacts", "completeThreeWay"\]\.includes\(command\)/);
  assert.doesNotMatch(body, /\["validatePlan", "dryRunPlan", "runPlan", "reproducePlan"\]\.includes\(command\)/);
  assert.doesNotMatch(source, /command === "validatePlan" \|\| command === "dryRunPlan"/);
  assert.doesNotMatch(source, /command === "runPlan" \|\| command === "reproducePlan"/);
});

test("backend primitive parsing reuses fixed value and type sets", () => {
  assert.match(source, /const BOOLEAN_TRUE_TEXTS = new Set\(\["1", "true", "yes", "on"\]\)/);
  assert.match(methodBody("function booleanField(message, key)", "function adapterRuleResultCandidates(rules)"), /BOOLEAN_TRUE_TEXTS\??\.has\(text\)/);
  assert.match(source, /const JSON_PRIMITIVE_TYPES = new Set\(\["string", "number", "boolean"\]\)/);
  assert.match(methodBody("function extractJsonParams(text)", "function extractPythonConfigParams(text)"), /entry === null \|\| JSON_PRIMITIVE_TYPES\??\.has\(typeof entry\)/);
});

test("backend action payload reads one scheduler snapshot", () => {
  const body = methodBody("    actionBody(message) {", "    actionPlanTarget(message) {");
  const fields = [
    "pollSeconds",
    "jitterSeconds",
    "workerStatusTtlSeconds",
    "workerAvailabilityPushSeconds",
    "operationEventMaxDelayMs",
    "workerActionMinIntervalMs",
    "workerActionMaxConcurrent",
  ];

  assert.equal((body.match(/this\.schedulerSettings\(\)/g) || []).length, 1);
  assert.match(body, /const scheduler = this\.schedulerSettings\(\)/);
  for (const field of fields) assert.match(body, new RegExp(`${field}: scheduler\\.${field}`));
});
