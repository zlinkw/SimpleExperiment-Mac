const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "..", "..");

test("native title tooltips avoid design notes and long explanations", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  const banned = [
    "参考 Kubernetes",
    "GitLens",
    "GitHub PR",
    "Cline/Continue",
    "直接解释主要按钮",
    "不允许点击后无反应",
    "为保证面板长时间运行稳定",
    "为保持大集群面板稳定",
    "为保持 Webview 长时间运行稳定",
    "完整状态仍",
    "完整进程仍",
    "这些参数用于",
    "只影响删除、停止、归档",
  ];
  for (const text of banned) assert.doesNotMatch(source, new RegExp(text), text);
  for (const expected of ["title=\"通信拓扑\"", "title=\"调度参数\""]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), expected);
  }
});

test("native title maintenance skips unchanged global scans and tracks dynamic writes", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  assert.match(source, /const compactKey = \[postRenderDomVersion, nativeTitleMutationVersion\]\.join\("::"\)/);
  assert.match(source, /if \(compactKey === lastNativeTitleCompactKey\) return/);
  assert.match(source, /function setNativeTitle\(node, value\)/);
  assert.match(source, /nativeTitleMutationVersion = \(nativeTitleMutationVersion \+ 1\) % 1000000/);
  const start = source.indexOf("function compactNativeTitleAttributes()");
  const end = source.indexOf("function compactNativeTitleText", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /\.title\s*=\s*/);
  assert.doesNotMatch(source.slice(source.indexOf("function setNativeTitle(node, value)"), source.indexOf("function setAllSectionsCollapsed", source.indexOf("function setNativeTitle(node, value)"))), /\.title\s*=\s*/);
});

test("compacted action titles remain available to custom tooltips", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  const start = source.indexOf("    function compactNativeTitleAttributes() {");
  const end = source.indexOf("\n    function compactNativeTitleText", start);
  assert.ok(start >= 0 && end > start);
  const attributes = new Map([["title", "保存配置并同步到 Worker"]]);
  const button = {
    tagName: "BUTTON",
    getAttribute: (key) => attributes.get(key) || null,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  const context = {
    postRenderDomVersion: 1,
    nativeTitleMutationVersion: 0,
    lastNativeTitleCompactKey: "",
    document: { querySelectorAll: () => [button] },
    compactNativeTitleText: () => "",
  };
  vm.runInNewContext(`${source.slice(start, end)}\ncompactNativeTitleAttributes();`, context);
  assert.equal(attributes.get("title"), undefined);
  assert.equal(attributes.get("data-tip"), "保存配置并同步到 Worker");
});
