const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("task rows keep active actions while legacy archive and delete are hidden", () => {
  const html = renderPanelHtml();
  for (const text of ["停止", "重试", "解析", "打开日志"]) {
    assert.match(html, new RegExp(text));
  }
  assert.match(html, /\["archiveArtifacts", "deleteArtifacts", "archivePlanCopy"\]\.includes\(command\)\) return ""/);
  assert.match(html, /selectLogRunKey/);
});
