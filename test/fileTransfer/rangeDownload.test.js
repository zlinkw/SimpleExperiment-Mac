const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("range download uses download-range endpoint", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/files/download-range?path=work_dirs%2Frun%2Ftrain.log&start=2&end=5");
    res.statusCode = 206;
    res.setHeader("Content-Length", "3");
    res.end("cde");
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-range-"));
  const target = path.join(dir, "part.log");
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    const task = await client.downloadRange("work_dirs/run/train.log", target, 2, 5);
    assert.equal(task.status, "completed");
    assert.equal(await fs.readFile(target, "utf8"), "cde");
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }