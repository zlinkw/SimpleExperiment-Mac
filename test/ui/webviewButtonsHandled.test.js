const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

test("all visible panel commands have extension handlers", () => {
  const root = path.join(__dirname, "..", "..");
  const html = readSource("src/ui/PanelHtml.ts");
  const extension = readSource("src/extension.ts");

  const commands = new Set();
  for (const match of html.matchAll(/data-command="([A-Za-z][A-Za-z0-9]+)"/g)) commands.add(match[1]);
  for (const match of html.matchAll(/actionButton\("([^"]+)",\s*"([^"]+)"/g)) {
    const command = /^[A-Za-z][A-Za-z0-9]+$/.test(match[2]) ? match[2] : match[1];
    if (/^[A-Za-z][A-Za-z0-9]+$/.test(command)) commands.add(command);
  }
  for (const command of ["selectLogRunKey", "stopExperiment", "retryExperiment", "parseResults", "archiveArtifacts", "deleteArtifacts"]) {
    commands.add(command);
  }

  const handled = new Set();
  for (const match of extension.matchAll(/case "([^"]+)"/g)) handled.add(match[1]);
  const uiActionBlock = extension.match(/const uiActionCommands = new Set<WebviewActionCommand>\(\[([\s\S]*?)\]\);/);
  if (uiActionBlock) {
    for (const match of uiActionBlock[1].matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)) handled.add(match[1]);
  }

  const missing = [...commands].filter((command) => !handled.has(command)).sort();
  assert.deepEqual(missing, []);
});
