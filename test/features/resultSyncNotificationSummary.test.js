const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
const start = source.indexOf("function formatResultSyncReport(");
const end = source.indexOf("function resultMetricMergeScopePaths(", start);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + "\nthis.format = formatResultSyncReport", sandbox);

test("result notification lists only unsuccessful items and keeps the full report intact", () => {
  const report = { discovered: 20, included: ["success.yaml：已重算"], pending: ["abandoned.yaml：尚无指标"], previews: ["running.yaml"],
    downloads: [{ reusedFiles: 2000, networkFiles: 100 }], missing: ["missing.yaml：完成作业缺少文件"],
    skipped: ["experiments/plans/comparison/image_only.yaml：本地指标无法解析（CSV 引号格式无效。），保留旧表。"] };
  const before = JSON.stringify(report);
  const notice = sandbox.format(report, "下载指标并重新汇总");
  assert.match(notice, /未成功.*2/);
  assert.match(notice, /image_only\.yaml/);
  assert.match(notice, /CSV 引号格式无效/);
  assert.match(notice, /missing\.yaml/);
  assert.doesNotMatch(notice, /success\.yaml|abandoned\.yaml|running\.yaml|SHA256|发现 Plan|成功收录/);
  assert.equal(JSON.stringify(report), before);
});

test("successful or pending-only sync notifications do not list abandoned Plans", () => {
  assert.equal(sandbox.format({ included: ["good"], pending: ["abandoned"] }, "同步"), "同步：完成。");
  assert.doesNotMatch(sandbox.format({ included: [], pending: ["abandoned"] }, "同步"), /abandoned|未成功|失败/);
});

test("large failure reports are deduplicated and bounded in notifications", () => {
  const skipped = Array.from({ length: 20 }, (_, i) => `experiments/plans/model-${i}.yaml：` + "异常".repeat(200));
  const notice = sandbox.format({ skipped: [...skipped, skipped[0]] }, "同步");
  assert.match(notice, /未成功.*20/);
  assert.ok(notice.length < 1100);
  assert.doesNotMatch(notice, /model-19\.yaml/);
  assert.match(notice, /完整记录/);
});
