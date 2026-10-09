const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("operation progress renders as a VS Code timeline", () => {
  const html = renderPanelHtml();
  const version = require("../../package.json").version;
  assert.match(html, new RegExp(`id="pluginVersionChip"[^>]*>v${version.replaceAll(".", "\\.")}</span>`));
  assert.match(html, /sort\(\(a, b\) => Number\(operationIsActive\(b\.status\)\) - Number\(operationIsActive\(a\.status\)\)/);
  assert.match(html, /\.operationTimeline \{ display: grid; gap: 6px; \}/);
  assert.match(html, /\.operationItem \{/);
  assert.match(html, /\.operationDot/);
  assert.match(html, /function renderOperationItem/);
  assert.match(html, /'<div class="operationTimeline">' \+ view\.visibleRows\.map\(\(row\) => renderOperationItem\(row, true\)\)\.join\(""\) \+ '<\/div>'/);
  assert.match(html, /operationDisplayMessage\(row\)/);
  assert.match(html, /const itemTitle = operationTypeLabel\(rawType\)/);
  assert.match(html, /title="' \+ escAttr\(itemTitle\) \+ '"/);
  assert.match(html, /function operationIsCancelled\(status\)/);
  assert.match(html, /operationStatusCard\("已取消", stats\.cancelled, "cancelled"\)/);
  assert.match(html, /operationStatusCard\("全部", stats\.total, "all"\)/);
  assert.match(html, /data-operation-filter=/);
  assert.match(html, /aria-pressed=/);
  assert.match(html, /function operationMatchesStatusFilter\(row, filter\)/);
  assert.match(html, /operationIsActive\(status\) && status !== "accepted" && status !== "submitted"/);
  assert.match(html, /当前筛选下没有操作记录/);
  assert.match(html, /operationStatusFilter === operationViewCacheFilter/);
  assert.match(html, /const restoredWebviewState = readStoredWebviewState\(vscode\)/);
  assert.match(html, /normalizeOperationStatusFilter\(restoredWebviewState\.operationStatusFilter\)/);
  assert.match(html, /persistWebviewState\(\{ operationStatusFilter \}\)/);
  assert.match(html, /vscode\.setState\(Object\.assign\(\{\}, readStoredWebviewState\(vscode\), patch \|\| \{\}\)\)/);
  assert.match(html, /return OPERATION_STATUS_FILTER_VALUES\.includes\(filter\) \? filter : "all"/);
  assert.match(html, /operationIsCancelled\(status\) \? "is-cancelled"/);
  assert.match(html, /if \(operationIsFailureLike\(.*\.status\)\) return .*\.error/);
  assert.match(html, /if \(operationIsCompleted\(.*\.status\)\) return "操作已完成。"/);
  assert.match(html, /meaningfulValue\(row\.progress\)/);
  assert.match(html, /const timestamp = operationTimestampView\(row\)/);
  assert.match(html, /timestamp\.label \+ "时间：" \+ timestamp\.raw/);
  assert.match(html, /minuteBucket === operationSectionSignatureCacheMinute/);
  const relativeSource = html.match(/function relativeTimeLabel\(value, nowMs\) \{[\s\S]*?\n    \}/)?.[0] || "";
  const relativeTimeLabel = vm.runInNewContext(relativeSource + "; relativeTimeLabel");
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.equal(relativeTimeLabel("2026-07-26T11:59:40.000Z", now), "刚刚");
  assert.equal(relativeTimeLabel("2026-07-26T11:55:00.000Z", now), "5 分钟前");
  assert.equal(relativeTimeLabel("2026-07-26T10:00:00.000Z", now), "2 小时前");
  assert.equal(relativeTimeLabel("-", now), "时间未知");
});

test("operation render budget scans priority groups without temporary filtered arrays", () => {
  const html = renderPanelHtml();
  const source = html.match(/function operationRowsForRender\(rows\) \{[\s\S]*?\n    \}/)?.[0] || "";
  const operationRowsForRender = vm.runInNewContext(source + "; operationRowsForRender", {
    OPERATION_RENDER_LIMIT: 4,
    operationIsActive: (status) => status === "running",
    operationIsFailureLike: (status) => status === "failed",
  });
  const rows = [
    { operationId: "done", status: "completed" },
    { operationId: "failed", status: "failed" },
    { operationId: "live", status: "running" },
    { operationId: "live", status: "failed" },
    { operationId: "fallback", status: "completed" },
  ];

  assert.deepEqual(Array.from(operationRowsForRender(rows), (row) => row.operationId), ["live", "failed", "done", "fallback"]);
  assert.doesNotMatch(source, /\.filter\(/);
  assert.match(source, /for \(const row of rows\)/);
});
