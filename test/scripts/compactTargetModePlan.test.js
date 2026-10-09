const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compactTargetModePlan,
  compactTargetModePlanFile,
} = require("../../scripts/compact-target-mode-plan");

test("compactTargetModePlan drops history and keeps only active sections", () => {
  const bloated = [
    "# 目标模式当前计划：旧标题",
    "",
    "本文档只保留最新活动目标。历史批次、验证和部署记录以 git 提交为准。",
    "",
    "## 固定边界",
    "",
    "- A",
    "- B",
    "- C",
    "- D",
    "- E",
    "- F",
    "- G",
    "- H",
    "- I should be trimmed",
    "",
    "## 后续优先级",
    "",
    "- one",
    "- two",
    "",
    "## 当前批次：Batch 999",
    "",
    "### 修复点",
    "",
    "- fix a",
    "",
    "### 边界",
    "",
    "- keep boundary",
    "",
    "### 相邻回归风险",
    "",
    "- keep risk",
    "",
    "### 验证清单",
    "",
    "- npm run build",
    "",
    "### project-236 记录",
    "",
    "- API methods for SimpleSFTP",
    "",
    "### 额外流水",
    "",
    "- should be removed",
    "",
    "## 本批记录",
    "",
    "- 目标版本：`0.1.473`。",
    "- note 1",
    "- note 2",
    "- note 3",
    "- note 4 should be trimmed",
    "",
    "## 历史批次流水账",
    "",
    "- Batch 1 ...",
    "- Batch 2 ...",
    "- Batch 3 ...",
    "",
    "## 已完成验证日志",
    "",
    "- long dump",
  ].join("\n");

  const result = compactTargetModePlan(bloated, { maxLines: 80 });
  assert.equal(result.changed, true);
  assert.match(result.text, /打包\/清理时会自动压缩本文件/);
  assert.match(result.text, /## 固定边界/);
  assert.match(result.text, /## 当前批次：Batch 999/);
  assert.match(result.text, /### 边界/);
  assert.match(result.text, /keep boundary/);
  assert.match(result.text, /### 相邻回归风险/);
  assert.match(result.text, /keep risk/);
  assert.match(result.text, /### project-236 记录/);
  assert.match(result.text, /API methods for SimpleSFTP/);
  assert.match(result.text, /## 本批记录/);
  assert.doesNotMatch(result.text, /历史批次流水账/);
  assert.doesNotMatch(result.text, /已完成验证日志/);
  assert.doesNotMatch(result.text, /I should be trimmed/);
  assert.doesNotMatch(result.text, /额外流水/);
  assert.ok(result.lineCount <= 80);
});

test("compactTargetModePlanFile rewrites on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-plan-"));
  const filePath = path.join(dir, "docs", "target-mode-plan.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "# 目标模式当前计划：测试",
    "",
    "## 固定边界",
    "",
    "- keep",
    "",
    "## 后续优先级",
    "",
    "- next",
    "",
    "## 当前批次：Batch X",
    "",
    "### 修复点",
    "",
    "- a",
    "",
    "## 本批记录",
    "",
    "- 目标版本：`0.0.0`。",
    "",
    "## 历史批次",
    "",
    "- old",
  ].join("\n"), "utf8");
  const result = compactTargetModePlanFile({ rootDir: dir, filePath: "docs/target-mode-plan.md" });
  assert.equal(result.changed, true);
  const text = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(text, /## 历史批次/);
  assert.match(text, /禁止堆积流水账/);
});

test("Mac plan preserves evidence below its character threshold and compacts at 90 percent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-mac-plan-"));
  const filePath = path.join(dir, "plan.md");
  const base = "# 目标模式当前计划：Mac\n字符上限 2000\n\n## 固定边界\n- keep\n## 后续优先级\n- next\n## 当前批次：mac-001\n### 验证清单\n- passed\n## 本批记录\n- commit abc\n";
  fs.writeFileSync(filePath, base, "utf8");
  assert.equal(compactTargetModePlanFile({ rootDir: dir, filePath }).changed, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), base);
  fs.writeFileSync(filePath, base + "\n## 历史批次\n" + "old evidence\n".repeat(140), "utf8");
  assert.equal(compactTargetModePlanFile({ rootDir: dir, filePath }).changed, true);
  const result = fs.readFileSync(filePath, "utf8");
  assert.ok(result.length < 2000);
  assert.match(result, /字符上限 2000/);
  assert.match(result, /commit abc/);
  assert.match(result, /passed/);
});
