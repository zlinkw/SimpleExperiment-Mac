const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("topbar removes network pause/resume and uses one settings entry", () => {
  const topbarStart = panel.indexOf('<div class="topbar-actions">');
  const topbarEnd = panel.indexOf("</div>", topbarStart);
  const topbar = panel.slice(topbarStart, topbarEnd);
  assert.doesNotMatch(topbar, /data-command="pauseAll"|data-command="resumeNetwork"/);
  assert.match(topbar, /data-section-target="settings"/);
  assert.doesNotMatch(topbar, /layoutEditToggle|collapseAllSections|expandAllSections|resetUiLayout/);
});

test("layout tools remain available inside settings and editing returns to workspace", () => {
  assert.match(panel, /class="settingsLayoutTools" data-anchor="settings-layout"/);
  assert.match(panel, /id="layoutEditToggle"/);
  assert.match(panel, /id="collapseAllSections"/);
  assert.match(panel, /id="expandAllSections"/);
  assert.match(panel, /data-command="resetUiLayout"/);
  assert.match(panel, /if \(!layoutEdit && currentMainView === "settings"\) switchMainView\("workspace"\);/);
  assert.match(panel, /section !== "servers" && section !== "settings"/);
});
