const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function readiness(state) {
  const sandbox = {
    asArray: (value) => Array.isArray(value) ? value : [],
    meaningfulValue: (value) => {
      const text = String(value || "").trim();
      return text && text !== "-" ? text : "";
    },
    pick: (item, keys, fallback) => {
      for (const key of keys) if (item && item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
      return fallback;
    },
    overviewTaskStats: (value) => value.taskStats || { running: 0, queued: 0, failed: 0, completed: 0 },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("overviewResultEvidenceReadiness") + "\nthis.check = overviewResultEvidenceReadiness;", sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(state)));
}

test("overview result evidence follows actual preview and archive state", () => {
  assert.equal(readiness({}).status, "待运行");
  assert.equal(readiness({ taskStats: { running: 1, queued: 0 } }).status, "等待任务结果");
  assert.deepEqual(readiness({ resultsSummary: { previewResultCount: 3, pendingReviewCount: 3 } }), {
    tone: "warn",
    status: "待筛选 3",
    detail: "完整预览已有结果，但尚未归档有效记录；后续分析不会读取这些临时记录。",
  });
  assert.equal(readiness({ resultsSummary: { previewResultCount: 3, effectiveArchivedResultCount: 2, pendingReviewCount: 1 } }).status, "有效 2 / 待筛选 1");
  assert.deepEqual(readiness({ resultsSummary: { effectiveArchivedResultCount: 2 } }), {
    tone: "good",
    status: "有效结果 2",
    detail: "已归档结果是质量门禁、统计、论文表格和 PPT 的唯一有效输入。",
  });
});
