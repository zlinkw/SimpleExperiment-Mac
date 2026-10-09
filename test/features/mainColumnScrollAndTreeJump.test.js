const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const htmlPath = path.join(__dirname, "..", "..", "src", "ui", "PanelHtml.ts");
const html = readSource("src/ui/PanelHtml.ts");

// 7c23e89 基线：html/body height 100%，cardDeck 用 translateX 抽屉，mainColumn 与 resourceTreeBody 可滚动。
test("drawer shell keeps main column scroll height chain", () => {
  assert.match(html, /html, body \{ height: 100%; \}/);
  assert.match(html, /\.app-shell \{[^}]*display: grid;[^}]*gap: 16px;/s);
  assert.match(html, /#cardDeck \{[^}]*--tree-col:/s);
  assert.match(html, /#cardDeck \{[^}]*display: grid|grid-template-columns:/s);
  assert.match(html, /\.mainColumn \{[^}]*overflow: auto/s);
  assert.match(html, /#resourceTreeBody \{[^}]*overflow: auto/s);
  assert.match(html, /--tree-peek|--tree-col|always-visible three columns/);
  assert.match(html, /--inspector-peek|--inspector-col/);
  assert.match(html, /transform: translateX\(calc\(-1 \* \(var\(--tree-col\) - var\(--tree-peek\)\)\)\)|always-visible three columns|transform: none/);
});

test("resource tree click resolves target and scrolls main column", () => {
  assert.match(html, /data-section-target/);
  assert.match(html, /function scrollToResourceTarget\(section, anchor\)/);
  assert.match(html, /card\.classList\.contains\("is-collapsed"\)/);
  assert.match(html, /main\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: "auto" \}\)/);
  assert.match(html, /function resolveResourceScrollTarget\(section, anchor\)/);
});
