const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const extension = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(root, "src/ui/PanelHtml.legacy.ts"), "utf8");

test("Agent preparation stays pending while its real deployment continues", () => {
  const watchdog = extension.slice(extension.indexOf("uiCommandWatchdogMs(command)"), extension.indexOf("private postUiCommandStatus("));
  assert.match(watchdog, /return 0/);
  assert.match(panel, /if \(command !== "prepareAgents" && command !== "rebuildProjectResultTables"\) \{[\s\S]{0,180}pendingActionTimeouts\[clientActionId\] = setInterval/);
  assert.match(panel, /if \(command !== "prepareAgents" && command !== "rebuildProjectResultTables"\) \{[\s\S]{0,900}pendingActionTimeouts\[clientActionId\] = setTimeout/);
});
