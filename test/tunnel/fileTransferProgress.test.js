const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file upload reports progress", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/files/upload-init") return res.end(JSON.stringify({ transferId: "progress", chunkSize: 2, accepted: true, resumeFromByte: 0 }));
      if (req.url.startsWith("/api/files/upload-chunk")) return res.end(JSON.stringify({ nextOffset: Number(new URL(req.url, "http://localhost").searchParams.get("offset") || 0) + 2 }));
      if (req.url === "/api/files/upload-complete") return res.end(JSON.stringify({ status: "completed", sha256: crypto.createHash("sha256").update("abcdef").digest("hex") }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-progress-"));
  const local = path.join(dir, "in.txt");
  await fs.writeFile(local, "abcdef", "utf8");
  const progress = [];
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port, chunkSizeBytes: 2 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }), (event) => progress.push(event));
  try {
    await client.uploadFile(local, "paper/tables/in.txt");
    assert.deepEqual(progress.map((item) => item.transferredBytes), [2, 4, 6]);
  } finally {
    await client.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
