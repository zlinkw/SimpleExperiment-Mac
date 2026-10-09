const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

test("section renderers isolate exceptions and report their section and document generation", () => {
  const start = panel.indexOf("function renderSectionIfVisible(state, section, options)");
  const end = panel.indexOf("function sectionPreRenderKey", start);
  const boundary = panel.slice(start, end);
  assert.match(boundary, /try \{/);
  assert.match(boundary, /catch \(error\)/);
  assert.match(boundary, /renderSectionFailure\(section, error\)/);
  assert.match(boundary, /data-section-retry/);
  assert.match(boundary, /data-command="reloadPanel"/);
  assert.match(boundary, /command: "webviewRenderError", documentGeneration: panelDocumentGeneration, section/);
  assert.match(extension, /panelSectionFailures\.add\(String\(message\.section\)\.slice\(0, 40\)\)[\s\S]{0,120}transitionPanelLifecycle\("degraded"/);
});

test("results throw leaves a local retry placeholder and later sections still render", () => {
  const start = panel.indexOf("function renderSectionIfVisible(state, section, options)");
  const end = panel.indexOf("function sectionPreRenderKey", start);
  const method = panel.slice(start, end).replace(/function recordPanelSectionSample\(/, "function unusedRecordPanelSectionSample(").replace(/\s+$/, "");
  const events = [], rendered = [], host = { innerHTML: "", querySelector: () => ({ addEventListener() {} }) };
  const context = {
    sectionIsCollapsed: () => false, sectionPreRenderKey: (_s, section) => section,
    lastSectionPreRenderKeys: {}, lastRenderedSectionSignatures: {}, sectionRenderSignature: (_s, section) => section,
    renderResultSummary() { throw new Error("fixture results failure"); },
    renderExecutionSection() { rendered.push("execution"); }, renderGpuSection() { rendered.push("gpu"); },
    applyResourceTreeChildLayout() {}, document: { querySelector: () => host },
    esc: value => String(value), escAttr: value => String(value), lastState: {}, panelDocumentGeneration: 8,
    cssEscape: value => String(value).replace(/["\\]/g, "\\$&"),
    sectionRenderModel: () => ({}),
    failedPanelSections: new Set(),
    recordPanelSectionSample() {},
    vscode: { postMessage: event => events.push(event) }, console: { warn() {} }, Date,
    performance: { now: (() => { let value = 1; return () => ++value; })() },
  };
  vm.runInNewContext(`${method}; this.renderSectionIfVisible = renderSectionIfVisible;`, context);
  context.renderSectionIfVisible({}, "results", { force: true });
  assert.match(host.innerHTML, /结果文件渲染失败/);
  assert.match(host.innerHTML, /data-section-retry="results"/);
  assert.ok(events.some(event => event.command === "webviewRenderError" && event.section === "results" && event.documentGeneration === 8));
  context.renderSectionIfVisible({}, "execution", { force: true });
  context.renderSectionIfVisible({}, "gpu", { force: true });
  assert.deepEqual(rendered, ["execution", "gpu"]);
});

test("global root checks remain in the fatal render boundary", () => {
  assert.match(panel, /function render\(state\) \{\s*try \{/);
  assert.match(panel, /updatePanelRenderHealth\("unhealthy", "render-failed:/);
  assert.match(panel, /webviewRenderError", documentGeneration: panelDocumentGeneration/);
});
