const assert = require("node:assert/strict");
const test = require("node:test");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("GPU refresh preserves chart canvases and skips unchanged backing-pixel redraws", () => {
  const html = renderPanelHtml();
  assert.match(html, /setHtmlPreservingGpuCanvases\("gpuHistoryOverview"/);
  assert.match(html, /setHtmlPreservingGpuCanvases\(bodyEl, bodyHtml\)/);
  assert.match(html, /function gpuHistoryCanvasKey\(canvas\)/);
  assert.match(html, /existing\.get\(gpuHistoryCanvasKey\(placeholder\)\)/);
  assert.match(html, /attribute\.name !== "width" && attribute\.name !== "height"/);
  assert.match(html, /canvas\.dataset\.drawSignature === drawSignature[\s\S]{0,180}return/);
  assert.match(html, /canvas\.width === Math\.round\(width \* dpr\) && canvas\.height === Math\.round\(height \* dpr\)/);
});
