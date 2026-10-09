const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("download streams to tmp then renames with progress", async () => {
  const body = Buffer.concat([Buffer.from("hello"), Buffer.from(" world")]);
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const server = http.createServer((req, res) => {
    assert.match(req.url, /^\/api\/files\/download\?path=results/);
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("X-Simple-File-Sha256", sha);
    res.write(body.subarray(0, 5));
    setTimeout(() => res.end(body.subarray(5)), 5);
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-stream-"));
  const target = path.join(dir, "metrics.csv");
  const progress = [];
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }), (event) => progress.push(event));
    const task = await client.download("results/metrics.csv", target);
    assert.equal(task.status, "completed");
    assert.equal(await fs.readFile(target, "utf8"), "hello world");
    assert.equal(progress.at(-1).transferredBytes, body.length);
    await assert.rejects(fs.stat(`${target}.tmp.${task.transferId}`));
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }