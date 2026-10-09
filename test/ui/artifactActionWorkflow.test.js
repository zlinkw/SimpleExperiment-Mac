const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("legacy artifact commands remain compatible without visible result buttons", () => {
  const html = renderPanelHtml();
  for (const command of ["archiveArtifacts", "syncArtifacts", "completeThreeWay", "deleteArtifacts", "reconcileDeletions"]) {
    assert.match(html, new RegExp(command));
  }
  assert.doesNotMatch(html, /id="artifactActions"/);
  assert.doesNotMatch(html, /data-command="archivePlanCopy"/);
});
