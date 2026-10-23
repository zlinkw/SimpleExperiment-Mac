const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("tree and onboarding keep object entries and step text", () => {
  assert.match(panel, /\.onboardingStep span \{[^}]*color: var\(--muted\)/);
  assert.match(panel, /function onboardingStep\(/);
  assert.match(panel, /function treeObjectItem\(/);
  // Mac 适配：树节点标题为 “Termius 会话”（Windows 为 “Xshell 会话”），条目结构断言不变。
  assert.match(panel, /treeObjectItem\("servers", "Termius 会话"/);
  assert.match(panel, /treeObjectItem\("servers", "服务器状态"/);
  assert.match(panel, /var\(--tree-col\)|always-visible three columns/);
});


