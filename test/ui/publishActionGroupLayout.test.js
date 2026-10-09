const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

function readStyle(html) {
  const start = html.indexOf("<style>");
  const end = html.indexOf("</style>", start);
  assert.ok(start >= 0 && end > start, "missing <style> block");
  return html.slice(start, end);
}

test("publish action groups have card layout instead of full-width bricks", () => {
  const html = renderPanelHtml();
  const style = readStyle(html);

  // Group/card selectors must exist (regression: previously 0 hits for .publishActionGroup).
  assert.match(style, /\.publishActionGroup/);
  assert.match(style, /\.publishActionButtons/);
  assert.match(style, /\.publishActionGroup\s*>\s*\.muted/);

  // Deck must be multi-column on desktop: auto-fit minmax(220px,1fr), not 1fr single column.
  assert.match(style, /\.publishActionDeck\s*\{[^}]*repeat\(auto-fit,\s*minmax\(220px,\s*1fr\)\)/);
  const desktopDeck = style.slice(0, style.indexOf("@media (max-width: 760px)"));
  assert.doesNotMatch(desktopDeck, /\.publishActionDeck\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test("publish action groups keep data-anchor/title and button semantics", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  assert.ok(src.includes("publishActionGroup"), "missing publishActionGroup markup");
  assert.ok(src.includes("publishActionButtons"), "missing publishActionButtons wrapper");
  assert.ok(src.includes("settings-chain-overview"), "sync actions must retain a visible navigation anchor");
  // 8 sync commands must still be wired through the grouping table.
  for (const cmd of ["publishGithub", "syncGithub", "overwriteGithub", "uploadProjectToHub", "uploadProjectToWorkers", "distributeCodeToWorkers", "deployLatestAgent", "configureDownloadScope"]) {
    assert.ok(src.includes(cmd), `missing sync command ${cmd}`);
  }
});
