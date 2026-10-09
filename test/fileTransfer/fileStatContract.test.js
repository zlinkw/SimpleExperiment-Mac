const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file stat contract returns exists size mtime and sha256", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/files/stat?path=work_dirs%2Frun%201%2Ftrain.log");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, path: "work_dirs/run 1/train.log", exists: true, type: "file", size: 5, mtime: "2026-01-01T00:00:00Z", sha256: "x" }));
  });
  await listen(server);
  try {
    const result = await new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} })).stat("work_dirs/run 1/train.log");
    assert.equal(result.exists, true);
    assert.equal(result.size, 5);
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }