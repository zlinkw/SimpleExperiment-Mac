const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
function method(name, next) {
  const start = source.indexOf(`    ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf(`    ${next}(`, start);
  assert.ok(end > start, next);
  return source.slice(start, end).trim();
}
function harness(config = {}) {
  const delays = [];
  const sandbox = {
    vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) } },
    DistributedSchedulingPolicy: { schedulingMode: value => value },
    setTimeout: (_callback, delay) => { delays.push(delay); return { unref() {} }; },
    clearTimeout() {},
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
  return { p, delays };
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

test("availability push uses configured cadence without delaying the distributed queue tick", () => {
  const { p, delays } = harness({ "scheduler.localAvailabilityPushSeconds": 27 });
  p.startAvailabilityPushLoop();
  assert.deepEqual(delays, [27000]);
  p.longRunningPlanRunOperations = () => [];
  p.startAvailabilityPushLoop();
  assert.deepEqual(delays, [27000]);
  assert.match(source, /setInterval\(\(\) => \{ void this\.tickDistributedQueue\(\)[^\n]+, 500\)/);
});
