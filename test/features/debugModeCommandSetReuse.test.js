const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

test("Extension Host reuses one fixed Debug command deny set", () => {
  const gate = functionSource("debugModeBlockedUiCommand");
  assert.match(source, /const DEBUG_MODE_BLOCKED_UI_COMMANDS = new Set\(\[/);
  assert.match(gate, /DEBUG_MODE_BLOCKED_UI_COMMANDS\.has/);
  assert.doesNotMatch(gate, /new Set\(/);
  for (const command of ["archivePlan", "deleteArtifacts", "runStatistics", "checkClaimEvidence", "plotResultsToPpt"]) {
    assert.match(source, new RegExp('"' + command + '"'));
  }
});
