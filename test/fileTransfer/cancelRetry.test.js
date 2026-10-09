const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("download retry succeeds after transient failure", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.statusCode = 503;
      return res.end("busy");
    }
    res.end("ok");
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-retry-"));
  const target = path.join(dir, "debug.zip");
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    const task = await client.download("simple_cluster/debug/debug.zip", target, { maxRetries: 1 });
    assert.equal(task.status, "completed");
    assert.equal(await fs.readFile(target, "utf8"), "ok");
    assert.equal(hits, 2);
  } finally {
    server.close();
  }
});

test("cancel unknown transfer is a no-op", async () => {
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: 65535 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
  await client.cancel("missing");
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }