const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.legacy.ts");
const extension = readSource("src/extension/legacy.ts");

/**
 * 按 data-title 划分面板区块，返回 { name, body }。
 *
 * 用「下一个 data-title」作为区块边界：嵌套子区块会被截断到自己的范围，
 * 不影响父区块已包含内容的判定。
 */
function extractSections(html) {
  const re = /data-title="([^"]+)"/g;
  const marks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    marks.push({ name: m[1], start: m.index });
  }
  return marks.map((mark, index) => ({
    name: mark.name,
    body: html.slice(mark.start, index + 1 < marks.length ? marks[index + 1].start : html.length),
  }));
}

/** 收集源码里所有「A > B」导航文案（中文引号包裹）。 */
function collectNavPaths(sources) {
  const found = [];
  for (const [file, src] of sources) {
    const re = /“([^”>]{1,24}) > ([^”]{1,24})”/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({ file, section: m[1], child: m[2], raw: m[0] });
    }
  }
  return found;
}

const sections = extractSections(panel);
const sectionNames = new Set(sections.map((s) => s.name));

test("面板至少定义了若干区块（护栏：防止解析失效导致空检查）", () => {
  assert.ok(sections.length >= 5, `解析到的区块数异常：${sections.length}`);
  assert.ok(sectionNames.has("实验准备"), "应能解析出「实验准备」区块");
  assert.ok(sectionNames.has("设置"), "应能解析出「设置」区块");
});

test("导航文案「A > B」的 A 必须是真实存在的面板区块", () => {
  const offenders = [];
  for (const nav of collectNavPaths([
    ["src/extension/legacy.ts", extension],
    ["src/ui/PanelHtml.legacy.ts", panel],
  ])) {
    if (!sectionNames.has(nav.section)) {
      offenders.push(`${nav.file}: 区块「${nav.section}」不存在（${nav.raw}）`);
    }
  }
  assert.deepEqual(offenders, [], `导航文案指向了不存在的区块：\n${offenders.join("\n")}`);
});

test("导航文案「A > B」的 B 必须出现在 A 区块的内容里", () => {
  const offenders = [];
  for (const nav of collectNavPaths([
    ["src/extension/legacy.ts", extension],
    ["src/ui/PanelHtml.legacy.ts", panel],
  ])) {
    const section = sections.find((s) => s.name === nav.section);
    if (!section) continue; // 由上一个用例负责报告
    if (!section.body.includes(nav.child)) {
      offenders.push(`${nav.file}: 「${nav.section}」区块内找不到「${nav.child}」（${nav.raw}）`);
    }
  }
  assert.deepEqual(offenders, [], `导航文案指向了区块内不存在的位置：\n${offenders.join("\n")}`);
});
