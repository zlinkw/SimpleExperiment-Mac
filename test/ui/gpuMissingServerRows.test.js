const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
require("../_helpers/registerTsRequire");
const { renderPanelHtml } = require("../../src/ui/PanelHtml.ts");

const browserSource = fs.readFileSync(path.join(__dirname, "../features/panelRenderHealth.test.js"), "utf8");
const ast = ts.createSourceFile("browser.js", browserSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "fakeBrowser");
const fakeBrowser = vm.runInNewContext("(" + node.getText(ast) + ")", { assert });
function browser() {
  const result = fakeBrowser();
  const createElement = result.document.createElement;
  result.document.createElement = tag => {
    const element = createElement(tag);
    Object.defineProperty(element, "childNodes", { get: () => [{ sourceHtml: element.innerHTML }] });
    return element;
  };
  for (const id of ["gpuHistoryOverview", "gpuDenseBody"]) {
    const element = result.element(id);
    element.replaceChildren = (...nodes) => { element.innerHTML = nodes.map(node => node.sourceHtml || "").join(""); };
  }
  const script = [...renderPanelHtml().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => script.includes('window.addEventListener("message"'));
  vm.runInNewContext(script, result.context);
  result.render = state => result.context.renderGpuSection(state);
  return result;
}
const workers = ["nwpu3", "nwpu2", "nwpu5"].map(id => ({ id, displayName: id.toUpperCase(), enabled: true }));
const row = index => ({ index, name: "3090", memoryUsedMb: 7, memoryTotalMb: 24576, utilizationPercent: 0 });
const state = { setup: { workerTunnels: workers }, gpu: { nwpu3: [], nwpu2: [row(0), row(1), row(2)], nwpu5: [row(0), row(1)] } };

test("an enabled server with no initial GPU data stays visible and is not counted as free GPU", () => {
  const b = browser();
  b.render(state);
  assert.match(b.element("gpuDenseBody").innerHTML, /NWPU3/);
  assert.match(b.element("gpuDenseBody").innerHTML, /暂未收到 GPU 数据/);
  assert.match(b.element("gpuSummary").innerHTML, /GPU 5/);
  assert.match(b.element("gpuSummary").innerHTML, /空闲 5/);
  b.render({ ...state, gpu: { ...state.gpu, nwpu3: [row(0), row(1), row(2), row(3)] } });
  assert.doesNotMatch(b.element("gpuDenseBody").innerHTML, /暂未收到 GPU 数据/);
  assert.match(b.element("gpuSummary").innerHTML, /GPU 9/);
});

test("configured servers without a GPU map entry are visible; disabled servers are excluded", () => {
  const b = browser();
  b.render({ ...state, setup: { workerTunnels: workers.map(w => ({ ...w, enabled: w.id !== "nwpu5" })) }, gpu: { nwpu2: state.gpu.nwpu2 } });
  assert.match(b.element("gpuDenseBody").innerHTML, /NWPU3/);
  assert.doesNotMatch(b.element("gpuDenseBody").innerHTML, /NWPU5/);
});

test("cached GPU rows are clearly marked stale in the dense table", () => {
  const b = browser();
  b.render({ ...state, gpu: { ...state.gpu, nwpu3: [row(0)] } });
  b.render(state);
  assert.match(b.element("gpuDenseBody").innerHTML, /数据陈旧/);
});

test("GPU sampler errors show the affected server and escaped original reason", () => {
  const b = browser();
  b.render({ ...state, gpu: { ...state.gpu, nwpu3: { gpus: [], status: "degraded", message: "driver <unavailable>" } } });
  assert.match(b.element("gpuDenseBody").innerHTML, /NWPU3/);
  assert.match(b.element("gpuDenseBody").innerHTML, /GPU 采样失败：driver &lt;unavailable&gt;/);
  assert.match(b.element("gpuSummary").innerHTML, /GPU 5/);
});

test("a sampler failure after a successful sample keeps cached rows stale and exposes the current error", () => {
  const b = browser();
  b.render({ ...state, gpu: { ...state.gpu, nwpu3: [row(0)] } });
  b.render({ ...state, gpu: { ...state.gpu, nwpu3: { gpus: [], status: "degraded", message: "device <unavailable>" } } });
  assert.match(b.element("gpuDenseBody").innerHTML, /数据陈旧/);
  assert.match(b.element("gpuDenseBody").innerHTML, /采样失败/);
  assert.match(b.element("gpuDenseBody").innerHTML, /device &lt;unavailable&gt;/);
});
