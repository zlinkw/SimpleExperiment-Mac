const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name) {
  const start = panelSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = panelSource.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return panelSource.slice(start, end + 1);
}

function loadBounds() {
  const sandbox = {
    meaningfulValue: (value) => {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" && text.toLowerCase() !== "unknown" && text.toLowerCase() !== "none" ? text : "";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("CONFIG_PORT_KEYS"),
    extractConst("CONFIG_PORT_BOUNDS"),
    extractConst("CONFIG_GPU_CONCURRENCY_BOUNDS"),
    extractConst("CONFIG_SCHEDULER_BOUNDS"),
    extractConst("EMPTY_CONFIG_INPUT_BOUNDS"),
    extractFunction("configInputBounds"),
    extractFunction("configBoundsHint"),
    extractFunction("configBoundsViolation"),
    "this.boundsFor = configInputBounds;",
    "this.hint = configBoundsHint;",
    "this.violation = configBoundsViolation;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("bounded fields state their allowed range", () => {
  const config = loadBounds();
  assert.equal(config.hint({ min: 1024, max: 65535 }), "1024–65535");
  assert.equal(config.hint({ min: 0, max: 1800 }), "0–1800");
  assert.equal(config.hint({ min: 1 }), "≥ 1");
  assert.equal(config.hint({ max: 16 }), "≤ 16");
  assert.equal(config.hint({}), "");
  assert.equal(config.hint(null), "");
});

test("out-of-range values are named precisely", () => {
  const config = loadBounds();
  const port = config.boundsFor("hub", "localForwardPort");
  assert.equal(config.violation(port, 80), "不得小于 1024");
  assert.equal(config.violation(port, 70000), "不得大于 65535");
  assert.equal(config.violation(port, 18080), "");
  assert.equal(config.violation(port, "abc"), "需要填写数字");
});

test("scheduler ranges match the documented policy bounds", () => {
  const config = loadBounds();
  const poll = config.boundsFor("scheduler", "pollSeconds");
  assert.equal(config.violation(poll, 0.5), "不得小于 5");
  assert.equal(config.violation(poll, 5), "");

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  for (const field of ["pollSeconds", "workerStatusTtlSeconds", "localAvailabilityPushSeconds", "workerAvailabilityPushSeconds", "operationEventMaxDelayMs", "workerActionMinIntervalMs"]) {
    assert.equal(config.boundsFor("scheduler", field).min, manifest.contributes.configuration.properties[`simpleExperiment.scheduler.${field}`].minimum, field);
  }

  const jitter = config.boundsFor("scheduler", "jitterSeconds");
  assert.equal(config.violation(jitter, 0), "", "zero jitter is allowed");
  assert.equal(config.violation(jitter, -1), "不得小于 0");

  const concurrent = config.boundsFor("scheduler", "workerActionMaxConcurrent");
  assert.equal(config.violation(concurrent, 0), "不得小于 1");
  assert.equal(config.violation(concurrent, 99), "不得大于 16");
});

test("config bounds reuse stable fixed definitions", () => {
  const config = loadBounds();
  assert.equal(config.boundsFor("hub", "localForwardPort"), config.boundsFor("worker", "remoteAgentPort"));
  assert.equal(config.boundsFor("worker", "maxConcurrentGpus"), config.boundsFor("scheduler", "workerActionMaxConcurrent"));
  assert.equal(config.boundsFor("hub", "projectRoot"), config.boundsFor("scheduler", "unknownKey"));
  assert.doesNotMatch(extractFunction("configInputBounds"), /const (?:portBounds|map)\s*=/);
});

test("unbounded and empty fields stay silent", () => {
  const config = loadBounds();
  const free = config.boundsFor("hub", "projectRoot");
  assert.equal(config.hint(free), "");
  assert.equal(config.violation(free, "anything"), "");
  assert.equal(config.violation(config.boundsFor("scheduler", "unknownKey"), "x"), "");

  const port = config.boundsFor("hub", "localForwardPort");
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(config.violation(port, empty), "", "an empty field must not be reported as invalid");
  }
});

test("the input renderer wires hint, error and invalid styling", () => {
  const renderer = extractFunction("configInput");
  assert.match(renderer, /const hint = configBoundsHint\(bounds\)/);
  assert.match(renderer, /const boundsViolation = configBoundsViolation\(bounds, value\)/);
  assert.match(renderer, /violation \? " is-invalid" : ""/);
  assert.match(renderer, /aria-invalid="true"/);
  assert.match(panelSource, /\.configBoundsHint \{/);
  assert.match(panelSource, /\.configBoundsError \{/);
  assert.match(panelSource, /\.field\.is-invalid > input \{/);
});
