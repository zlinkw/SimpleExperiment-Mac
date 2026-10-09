const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("capability-driven UI disables missing agent features before click", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  assert.match(source, /runPlan:\s*\["actions\.run-plan"\]/);
  assert.match(source, /refreshResults:\s*\["actions\.refresh-results",\s*"endpoints\.resultsSummary"\]/);
  assert.match(source, /downloadDebugBundle:\s*\[\]/);
  assert.match(source, /downloadRemoteResult:\s*\[\]/);
  assert.match(source, /"downloadDebugBundle", "downloadRemoteResult"/);
  assert.match(source, /const keys = uiCapabilityMap\[command\] \|\| \[\];\s*const missing = keys\.filter\(\(key\) => !hasCapability\(state, key\)\);/);
  assert.match(source, /return Boolean\(endpoints\.actions && actionEndpoints\[action\] === true\)/);
  assert.match(source, /button\.disabled = Boolean\(reason\)/);
  assert.match(source, /function planButtonDisableReason\([\s\S]*?disableReason\(/);
  assert.match(source, /if \(button && !button\.disabled\)/);
});
