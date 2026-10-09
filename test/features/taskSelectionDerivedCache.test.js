const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractMethod(name) {
  const match = new RegExp(`^\\s*(?:private\\s+)?(?:async\\s+)?${name}\\(`, "m").exec(source);
  assert.ok(match, `missing method ${name}`);
  const typedBuildStateMarker = "): WebviewClusterState {";
  const body = name === "buildState"
    ? source.indexOf(typedBuildStateMarker, match.index) + typedBuildStateMarker.length - 1
    : source.indexOf("{", match.index);
  assert.ok(body >= match.index, `missing method body ${name}`);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1).trim();
  }
  throw new Error(`unterminated method ${name}`);
}

function runtimeMethod(name) {
  return extractMethod(name).replace(/^private\s+/, "");
}

test("Extension Host reuses task selection snapshots and protected keys until invalidated", () => {
  const sandbox = {
    uniqueStrings(values) { return [...new Set(values)]; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    class Subject {
      selectedExperimentIds = new Set(["experiment-a"]);
      selectedRunKeys = new Set(["run-a"]);
      selectedRunKey = "run-a";
      selectedArchiveKeys = new Set(["archive-a"]);
      selectedTaskUiKeys = new Set(["task-a"]);
      hiddenLegacyTaskUiKeys = new Set(["legacy-a"]);
      selectedLogRunKey = "log-a";
      taskSelectionRevision = 0;
      taskSelectionDerivedCache;
      ${runtimeMethod("markTaskSelectionChanged")}
      ${runtimeMethod("taskSelectionDerivedState")}
      ${runtimeMethod("schedulerProtectedKeys")}
      ${runtimeMethod("traceProtectedKeys")}
      ${runtimeMethod("logProtectedKeys")}
    }
    this.Subject = Subject;
  `, sandbox);

  const subject = new sandbox.Subject();
  const first = subject.taskSelectionDerivedState();
  assert.strictEqual(subject.taskSelectionDerivedState(), first);
  assert.strictEqual(subject.schedulerProtectedKeys(), first.schedulerProtectedKeys);
  assert.strictEqual(subject.traceProtectedKeys(), first.traceProtectedKeys);
  assert.strictEqual(subject.logProtectedKeys(), first.logProtectedKeys);
  assert.deepEqual(Array.from(first.schedulerProtectedKeys), ["run-a", "experiment-a", "archive-a", "task-a", "log-a"]);
  assert.deepEqual(Array.from(first.traceProtectedKeys), ["run-a", "experiment-a", "archive-a"]);
  assert.deepEqual(Array.from(first.logProtectedKeys), ["log-a", "run-a", "task-a"]);

  subject.selectedRunKeys.add("run-b");
  subject.selectedRunKey = "run-b";
  subject.markTaskSelectionChanged();
  const next = subject.taskSelectionDerivedState();
  assert.notStrictEqual(next, first);
  assert.deepEqual(Array.from(next.selectedRunKeys), ["run-a", "run-b"]);
  assert.equal(next.selectedRunKey, "run-b");
  assert.equal(next.schedulerProtectedKeys.includes("run-b"), true);
});

test("task selection mutations invalidate the shared derivation and buildState reuses its arrays", () => {
  for (const name of ["schedulerProtectedKeys", "traceProtectedKeys", "logProtectedKeys"]) {
    assert.match(extractMethod(name), /this\.taskSelectionDerivedState\(\)/, name);
  }
  for (const name of ["resetProjectContextInMemory", "loadProjectTaskSelectionState", "selectExperimentFromUi", "clearLegacyTasksFromUi"]) {
    assert.match(extractMethod(name), /this\.markTaskSelectionChanged\(\)/, name);
  }
  const logSelectionCase = extractMethod("handleMessageCore").match(/case "selectLogRunKey":([\s\S]*?)break;/);
  assert.ok(logSelectionCase, "log selection case exists");
  assert.match(logSelectionCase[1], /this\.markTaskSelectionChanged\(\)/);

  const buildState = extractMethod("buildState");
  assert.match(buildState, /const taskSelection = this\.taskSelectionDerivedState\(\)/);
  assert.match(buildState, /selectedRunKeys: taskSelection\.selectedRunKeys/);
  assert.match(buildState, /hiddenLegacyTaskUiKeys: taskSelection\.hiddenLegacyTaskUiKeys/);
  assert.doesNotMatch(buildState, /selectedRunKeys: \[\.\.\.this\.selectedRunKeys\]/);
});
