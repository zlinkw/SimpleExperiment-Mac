const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadNormalizers() {
  const sandbox = {
    activeResourceSection: "plans",
    RESOURCE_TREE_SECTION_KEYS: new Set(["overview", "servers", "settings", "gpu", "execution", "plans", "results", "sync", "diagnostics"]),
    SAVED_ACTION_PAYLOAD_KEYS: Object.freeze(["endpointId", "planFile", "planRevision", "planId", "file", "runKey", "taskUiKey", "experimentId", "archiveKey", "experimentIndex", "gpuId", "workerId", "remotePath", "confirmationPath", "artifactPath", "resultPath", "logPath", "savePlan", "batchSelected"]),
    BUTTON_PAYLOAD_ATTRIBUTE_NAMES: Object.freeze({ planFile: "plan-file", runKey: "run-key", sourcePath: "source-path" }),
    BUTTON_PAYLOAD_ATTRIBUTE_KEYS: Object.freeze(["planFile", "runKey", "sourcePath"]),
    PINNED_COMMAND_VALUES: new Set(["runPlan", "parseResults", "publishGithub"]),
    webviewHandledCommands: new Set(["runPlan", "parseResults", "publishGithub"]),
    pinnedCommandsNormalizationCache: new WeakMap(),
    savedButtonActionsNormalizationCache: new WeakMap(),
    SAVED_BUTTON_ACTION_NORMALIZATION_VARIANT_LIMIT: 8,
    labelCalls: 0,
    featureCommandLabel(command) {
      sandbox.labelCalls += 1;
      return { runPlan: "Run", parseResults: "Parse", publishGithub: "Publish" }[command] || command;
    },
    compactText(value, limit) {
      return String(value || "").slice(0, limit);
    },
    escAttr(value) {
      return String(value || "");
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("normalizePinnedCommands"),
    extractFunction("normalizeSavedButtonActions"),
    extractFunction("normalizeSavedButtonAction"),
    extractFunction("normalizeActionSection"),
    extractFunction("sanitizeActionPayload"),
    extractFunction("actionSpecId"),
    extractFunction("buttonPayloadAttributes"),
    "this.normalizePinned = normalizePinnedCommands;",
    "this.normalizeActions = normalizeSavedButtonActions;",
    "this.normalizeSection = normalizeActionSection;",
    "this.payloadAttributes = buttonPayloadAttributes;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("pinned command normalization reuses one source array and invalidates on replacement", () => {
  const sandbox = loadNormalizers();
  const commands = ["runPlan", "unknown", "runPlan", "parseResults"];
  const first = sandbox.normalizePinned(commands);

  assert.strictEqual(sandbox.normalizePinned(commands), first);
  assert.deepEqual(Array.from(first), ["runPlan", "parseResults"]);
  assert.notStrictEqual(sandbox.normalizePinned([...commands]), first);
});

test("saved action normalization caches by source, limit, and active section", () => {
  const sandbox = loadNormalizers();
  const actions = [
    { command: "runPlan", payload: { planFile: "experiments/plans/demo.yaml", shellCommand: "blocked" } },
    { command: "runPlan", payload: { planFile: "experiments/plans/demo.yaml", shellCommand: "blocked" } },
    { command: "unknown", payload: { planFile: "ignored.yaml" } },
  ];
  const first = sandbox.normalizeActions(actions, 16);
  const labelCalls = sandbox.labelCalls;

  assert.strictEqual(sandbox.normalizeActions(actions, 16), first);
  assert.equal(sandbox.labelCalls, labelCalls);
  assert.equal(first.length, 1);
  assert.equal(first[0].section, "plans");
  assert.equal(first[0].payload.planFile, "experiments/plans/demo.yaml");
  assert.equal(first[0].payload.shellCommand, undefined);

  sandbox.activeResourceSection = "results";
  const changedSection = sandbox.normalizeActions(actions, 16);
  assert.notStrictEqual(changedSection, first);
  assert.equal(changedSection[0].section, "results");
  assert.notStrictEqual(sandbox.normalizeActions(actions, 1), changedSection);
  assert.notStrictEqual(sandbox.normalizeActions([...actions], 16), changedSection);
});

test("saved action normalization keeps only the newest bounded variants", () => {
  const sandbox = loadNormalizers();
  const actions = [{ command: "runPlan", payload: { planFile: "demo.yaml" } }];
  const sections = ["overview", "settings", "gpu", "plans", "execution", "results", "sync", "diagnostics"];
  const oldest = sandbox.normalizeActions(actions, 16);
  for (const section of sections.slice(1)) {
    sandbox.activeResourceSection = section;
    sandbox.normalizeActions(actions, 16);
  }
  sandbox.normalizeActions(actions, 15);
  const variants = sandbox.savedButtonActionsNormalizationCache.get(actions);
  assert.equal(variants.size, 8);
  sandbox.activeResourceSection = "overview";
  assert.notStrictEqual(sandbox.normalizeActions(actions, 16), oldest);
  assert.equal(variants.size, 8);
});

test("saved action payload and button attributes reuse fixed field definitions", () => {
  const sandbox = loadNormalizers();
  const attrs = sandbox.payloadAttributes({ sourcePath: "results/a.csv", runKey: "run-1", planFile: "demo.yaml", batchSelected: true, shellCommand: "blocked" });
  assert.equal(attrs, ' data-plan-file="demo.yaml" data-run-key="run-1" data-source-path="results/a.csv"');
  assert.match(panel, /const SAVED_ACTION_PAYLOAD_KEYS = Object\.freeze\(\[/);
  assert.match(panel, /const BUTTON_PAYLOAD_ATTRIBUTE_NAMES = Object\.freeze\(\{/);
  assert.match(panel, /const BUTTON_PAYLOAD_ATTRIBUTE_KEYS = Object\.freeze\(Object\.keys\(BUTTON_PAYLOAD_ATTRIBUTE_NAMES\)\)/);
  assert.match(panel, /SAVED_ACTION_PAYLOAD_KEYS\.forEach/);
  assert.match(panel, /BUTTON_PAYLOAD_ATTRIBUTE_KEYS\.map/);
});

test("panel reuses fixed resource section tone and inspector lookups", () => {
  const sandbox = loadNormalizers();
  assert.equal(sandbox.normalizeSection("results"), "results");
  assert.equal(sandbox.normalizeSection("server-worker"), "sync");
  assert.equal(sandbox.normalizeSection("unknown"), "overview");

  const toneSandbox = {
    RESOURCE_TREE_TONE_VALUES: new Set(["good", "info", "warn", "error", "mine"]),
  };
  vm.createContext(toneSandbox);
  vm.runInContext(`${extractFunction("normalizeTreeTone")}\nthis.normalizeTone = normalizeTreeTone;`, toneSandbox);
  assert.equal(toneSandbox.normalizeTone("MINE"), "mine");
  assert.equal(toneSandbox.normalizeTone("unknown"), "");

  assert.match(panel, /const RESOURCE_TREE_TONE_VALUES = new Set\(\["good", "info", "warn", "error", "mine"\]\)/);
  assert.match(panel, /const INSPECTOR_OPERATION_SECTIONS = new Set\(\["execution"\]\)/);
  assert.match(panel, /RESOURCE_TREE_SECTION_KEYS\??\.has\(value\)/);
  assert.match(panel, /RESOURCE_TREE_TONE_VALUES\??\.has\(value\)/);
  assert.equal((panel.match(/INSPECTOR_OPERATION_SECTIONS\?\.has/g) || []).length, 4);
});
