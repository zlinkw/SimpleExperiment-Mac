const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file list contract returns schema path and entries", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(decodeURIComponent(req.url), "/api/files/list?path=results/论文 表格");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, path: "results/论文 表格", entries: [{ name: "metrics.csv", path: "results/论文 表格/metrics.csv", type: "file", size: 12, sha256: "abc" }] }));
  });
  await listen(server);
  try {
    const client = makeClient(server);
    const result = await client.list("results/论文 表格");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.entries[0].name, "metrics.csv");
  } finally {
    server.close();
  }
});

function makeClient(server) {
  return new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
}
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }