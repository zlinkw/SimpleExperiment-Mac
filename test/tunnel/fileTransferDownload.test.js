const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file transfer downloads over local HTTP API", async () => {
  const server = http.createServer((req, res) => {
    assert.match(req.url, /^\/api\/files\/download\?path=work_dirs/);
    res.setHeader("Content-Length", "5");
    res.end("hello");
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-dl-"));
  const target = path.join(dir, "out.txt");
  const progress = [];
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }), (event) => progress.push(event));
  try {
    const task = await client.downloadFile("work_dirs/run/metrics.csv", target);
    assert.equal(await fs.readFile(target, "utf8"), "hello");
    assert.equal(task.status, "completed");
    assert.equal(progress.at(-1).transferredBytes, 5);
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
