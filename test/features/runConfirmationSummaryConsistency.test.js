const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

test("confirmation summary derives task count from cases and seeds when jobCount is absent", () => {
  assert.match(extension, /function planRunKnownJobCount\(plan\)/);
  assert.match(extension, /return cases\.length && seeds\.length \? cases\.length \* seeds\.length : 0/);
  assert.match(extension, /const knownJobs = rows\.map\(\(plan\) => planRunKnownJobCount\(plan\)\)/);
  assert.match(extension, /实际任务输出目录/);
  assert.match(extension, /实验项（case）与随机种子（seed）展开/);
});
