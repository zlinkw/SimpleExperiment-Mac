const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

test("operation probes and watchdogs retain their initiating client authority", () => {
  const scheduleStart = source.indexOf("scheduleOperationWatchdog(opId");
  const schedule = source.slice(scheduleStart, source.indexOf("operationStatusProbeDelayMs", scheduleStart));
  assert.ok([...schedule.matchAll(/const authorityClient = this\.client/g)].length >= 2);
  assert.match(schedule, /finishOperationWatchdog\(opId, action, workerId, authorityClient\)/);
  assert.match(schedule, /refreshOperationStatus\(opId, action, workerId, attempt, authorityClient\)/);
  assert.match(schedule, /this\.operationTimers\.get\(opId\) === timer/);
  assert.match(schedule, /this\.operationProbeTimers\.get\(opId\) === timer/);

  const watchdogStart = source.indexOf("async finishOperationWatchdog");
  const watchdog = source.slice(watchdogStart, source.indexOf("async refreshOperationStatus", watchdogStart));
  assert.match(watchdog, /authorityClient = this\.client/);
  assert.ok([...watchdog.matchAll(/authorityClient !== this\.client/g)].length >= 2);

  const refreshStart = source.indexOf("async refreshOperationStatus");
  const refresh = source.slice(refreshStart, source.indexOf("clearOperationWatchdog", refreshStart));
  assert.match(refresh, /authorityClient = this\.client/);
  assert.match(refresh, /authorityClient\.getWorkerOperation\(workerId, opId\)/);
  assert.match(refresh, /authorityClient\.getOperation\(opId\)/);
  assert.match(refresh, /generation !== this\.projectContextGeneration \|\| authorityClient !== this\.client/);
  assert.ok(refresh.indexOf("authorityClient !== this.client") < refresh.indexOf("this.localOperations[opId] ="));
});
