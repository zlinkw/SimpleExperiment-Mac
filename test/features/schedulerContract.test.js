const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");
require('../_helpers/registerTsRequire');

require('../_helpers/registerTsRequire');
const source = readSource("src/extension.ts");
function method(name, next) {
  const start = source.indexOf(`    ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf(`    ${next}(`, start);
  assert.ok(end > start, next);
  return source.slice(start, end).trim();
}
function harness(config = {}) {
  const delays = [], cleared=[];
  const sandbox = {
    vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) } },
    GpuMemoryScheduling: require("../../src/features/GpuMemoryScheduling.ts"),
    GpuQuotaScheduling: require("../../src/features/GpuQuotaScheduling.ts"),
    DistributedSchedulingPolicy: { schedulingMode: value => value },
    GpuQuotaScheduling: require('../../src/features/GpuQuotaScheduling.ts'),
    GpuMemoryScheduling: require('../../src/features/GpuMemoryScheduling.ts'),
    setTimeout: (_callback, delay) => { delays.push(delay); return { unref() {} }; },
    clearTimeout(timer) {cleared.push(timer);},
  };
  vm.createContext(sandbox);
  vm.runInContext(`class Harness {
    ${method("schedulerSettings", "refreshResultCsvDirectory")}
    ${method("startAvailabilityPushLoop", "availabilityPushMinIntervalMs")}
    ${method("availabilityPushMinIntervalMs", "availabilityPushTtlSeconds")}
  }; this.provider = new Harness();`, sandbox);
  const p = sandbox.provider;
  p.availabilityPushLoopGeneration = 0;
  p.isRealtimeMode = () => true;
  p.projectTopologyAssessment = () => ({ hubAllowed: true });
  p.longRunningPlanRunOperations = () => [{}];
  return { p, delays, cleared };
}

test("scheduler settings enforce the documented bounds and honor configured push intervals", () => {
  const { p } = harness({ "scheduler.pollSeconds": 0.5, "scheduler.localAvailabilityPushSeconds": 0.5, "scheduler.workerAvailabilityPushSeconds": 30 });
  const settings = p.schedulerSettings();
  assert.equal(settings.pollSeconds, 5);
  assert.equal(settings.localAvailabilityPushSeconds, 5);
  assert.equal(settings.workerAvailabilityPushSeconds, 30);
  assert.equal(p.availabilityPushMinIntervalMs(settings), 5000);
  const defaults = harness().p.schedulerSettings();
  assert.equal(defaults.pollSeconds, 10);
  assert.equal(defaults.workerStatusTtlSeconds, 45);
  assert.equal(defaults.localAvailabilityPushSeconds, 10);
  assert.equal(defaults.workerAvailabilityPushSeconds, 10);
  assert.equal(defaults.sessionCheckMinSeconds, 5);
});

test("retired availability push cannot start network timers; active queue polling remains registered", () => {
  const { p, delays } = harness({ "scheduler.localAvailabilityPushSeconds": 27 });
  p.startAvailabilityPushLoop();
  assert.deepEqual(delays, [], 'native Worker pulls do not revive the retired availability publisher');
  p.longRunningPlanRunOperations = () => [];
  p.startAvailabilityPushLoop();
  assert.deepEqual(delays, []);
  assert.match(source, /setInterval\(\(\) => \{ void this\.tickDistributedQueue\(\)[^\n]+, 500\)/);
});

test("retired availability push clears its owned timer and cannot restart while tasks run", () => {
  const {p,delays,cleared}=harness({"scheduler.localAvailabilityPushSeconds":27});
  const originalTimer={id:'owned-push-timer'};p.availabilityPushTimer=originalTimer;
  p.startAvailabilityPushLoop();assert.deepEqual(delays,[]);assert.deepEqual(cleared,[originalTimer]);assert.equal(p.availabilityPushTimer,undefined);
  assert.equal(p.availabilityPushLoopGeneration,1);p.longRunningPlanRunOperations=()=>[];p.startAvailabilityPushLoop();
  assert.deepEqual(delays,[]);assert.deepEqual(cleared,[originalTimer]);assert.equal(p.availabilityPushLoopGeneration,2);
  assert.match(source,/setInterval\(\(\) => \{ void this\.tickDistributedQueue\(\)[^\n]+, 500\)/);
});
