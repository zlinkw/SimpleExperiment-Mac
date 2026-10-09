const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

function renderPanelHtmlFromSource(source) {
  return require("../../dist/ui/PanelHtml.js").renderPanelHtml();
}

// 7c23e89 抽屉基线：topbar-actions 是普通 div，直接在 </header> 前闭合。
test("topbar-actions closes before header so three columns are not clipped", () => {
  const html = renderPanelHtmlFromSource(panel);
  assert.match(html, /<div class="topbar-actions">[\s\S]*?<\/div>\s*<\/header>/);
  assert.match(html, /<\/header>\s*<div id="projectOnboardingNotice"[^>]*><\/div>\s*<div id="renderError"/);
  // balanced topbar fragment: actions wrapper must not swallow cardDeck
  const body = html.slice(html.indexOf("<body"), html.indexOf("<script"));
  const topbar = body.slice(body.indexOf('<header class="topbar"'), body.indexOf("</header>") + 9);
  const openDivs = (topbar.match(/<div\b/g) || []).length;
  const closeDivs = (topbar.match(/<\/div>/g) || []).length;
  assert.equal(openDivs, closeDivs);
  assert.match(body, /id="cardDeck"/);
  assert.ok(body.indexOf('id="cardDeck"') > body.indexOf("</header>"));
});

// 基线用 renderSectionIfVisible 做增量渲染与签名缓存，不做 forceFullUiPaint。
test("incoming state renders sections via renderSectionIfVisible with signature cache", () => {
  assert.match(panel, /function renderSectionIfVisible\(/);
  assert.match(panel, /let lastRenderedSectionSignatures = \{\}/);
  assert.match(panel, /let sectionDataSignatureCacheState = null/);
  assert.match(panel, /if \(sectionDataSignatureCacheState !== cacheState\)/);
  assert.match(panel, /Object\.prototype\.hasOwnProperty\.call\(sectionDataSignatureCache, section\)/);
  assert.match(panel, /stableSectionSignature\(sectionRenderModel\(state, section\)\)/);
  assert.match(panel, /htmlSignature\(section \+ "::" \+ modelSignature \+ "::" \+ sectionLocalSignature\(section, state\)\)/);
  assert.match(panel, /let resourceTreeStaticModelCache = null;/);
  assert.match(panel, /renderSectionIfVisible\(lastState \|\| \{\}, "[a-z]+"[,)]/);
  // 抽屉 rails：translateX 隐藏 + hover 展开
  assert.match(panel, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)/);
  assert.match(panel, /transform: translateX\(calc\(var\(--inspector-col\) - var\(--inspector-peek\)\)\)/);
  assert.match(panel, /\.resourceTree:hover/);
  assert.match(panel, /\.workbenchInspector:hover|\.workbenchInspector:focus-within/);
});

test("scheduler row cache declared and reused", () => {
  const decl = panel.indexOf("let schedulerRowsCacheState = null;");
  assert.ok(decl >= 0);
  const reuse = panel.indexOf("schedulerRowsCacheState === state");
  assert.ok(reuse > decl);
  // no second late declaration
  const late = panel.indexOf("let schedulerRowsCacheState = null;", decl + 1);
  assert.equal(late, -1);
});

test("drawer rails keep peeks and expand on hover", () => {
  assert.match(panel, /--tree-peek/);
  assert.match(panel, /--inspector-peek/);
  assert.match(panel, /resourceTree:hover/);
  assert.match(panel, /workbenchInspector:hover|workbenchInspector:focus-within/);
  assert.match(panel, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)/);
  const html = renderPanelHtmlFromSource(panel);
  assert.match(html, /id="resourceTree"/);
  assert.match(html, /id="mainColumn"/);
  assert.match(html, /id="workbenchInspector"/);
  assert.match(html, /--tree-peek/);
});

// 基线用 vscode 主题变量 + section-desc + renderError + 选择左侧资源树文案。
test("result-affecting ops auto-parse selected plan before summary refresh", () => {
  assert.match(extension, /queueSelectedPlanResultParse\(/);
  assert.match(extension, /queueSelectedPlanResultParse\("Worker 结果动作"/);
  assert.match(extension, /queueSelectedPlanResultParse\(command, planHint\)/);
  assert.match(extension, /queueSelectedPlanResultParse\(command, planHint\)/);
  assert.match(extension, /if \(!RESULT_PARSE_COMMANDS\??\.has\(command\)\)/);
  // still keep selected-plan gate
  assert.match(extension, /shouldRefreshResultsSummaryForDirtyPlan\(fromHint\)/);
  assert.match(extension, /Only auto-parse the currently selected plan/);
});

// 基线 cardDeck 用 translateX 抽屉 + overflow: hidden，不用 absolute rails。
test("drawer content uses translateX side rails with hidden overflow", () => {
  assert.match(panel, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)/);
  assert.match(panel, /transform: translateX\(calc\(var\(--inspector-col\) - var\(--inspector-peek\)\)\)/);
  assert.match(panel, /#cardDeck[\s\S]*overflow: hidden/);
  assert.match(panel, /renderSectionIfVisible\(/);
});
