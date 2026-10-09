const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

test("run confirmations and Plan cards explain task expansion in Chinese", () => {
  assert.match(extension, /任务规模：\$\{caseCount\} 个实验项 × \$\{seedCount\} 个随机种子 = \$\{expandedCount\} 个任务/);
  assert.match(extension, /任务规模：1 个实验项 × 1 个随机种子 = 1 个任务/);
  assert.match(panel, /cases\.length \+ " 个实验项 × " \+ seeds\.length \+ " 个随机种子 = " \+ expanded \+ " 个任务"/);
  assert.match(panel, /个任务（实验项\/随机种子待校验）/);
  assert.doesNotMatch(panel, /" case × " \+ seeds\.length/);
  assert.doesNotMatch(extension, /个 case × \$\{seedCount\} 个 seed/);
  assert.match(extension, /function planRunCommandSummary\(plan, limit = 240\)/);
  assert.match(extension, /实际执行命令：/);
});
