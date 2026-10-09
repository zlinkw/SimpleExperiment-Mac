const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file API encodes chinese paths and spaces", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(`http://x${req.url}`);
    assert.equal(url.searchParams.get("path"), "experiments/计划 文件/schema 配置.json");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, path: url.searchParams.get("path"), exists: true, type: "file", size: 1 }));
  });
  await listen(server);
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    const stat = await client.stat("experiments/计划 文件/schema 配置.json");
    assert.equal(stat.exists, true);
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }