const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeFileTransferRows } = require("../../dist/ui/WebviewRenderState.js");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("active file transfer progress is rendered with a bounded row list", () => {
  const html = renderPanelHtml();
  assert.match(html, /renderFileTransferProgress\(state && state\.fileTransfers\)/);
  assert.match(html, /status === "running" \|\| status === "pending" \|\| status === "progress"/);
  assert.match(html, /\.slice\(0, 20\)/);
  assert.doesNotMatch(html, /transferTable/);
  assert.doesNotMatch(html, /lastKnownGood\.fileTransfers/);
});

test("file transfer normalize accepts progress aliases", () => {
  const rows = normalizeFileTransferRows({
    tx1: {
      direction: "download",
      remote_path: "/remote/a.txt",
      local_path: "D:/a.txt",
      state: "completed",
      transferred_bytes: 10,
      total_bytes: 10,
      speed_bytes_per_second: 100,
      eta_seconds: 0,
    },
  });
  assert.equal(rows[0].transferId, "tx1");
  assert.equal(rows[0].remotePath, "/remote/a.txt");
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].transferredBytes, 10);
});
