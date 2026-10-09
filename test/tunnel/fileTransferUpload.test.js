const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file transfer uploads chunks over local HTTP API", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    const binary = req.headers["content-type"] === "application/octet-stream";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      seen.push({ url: req.url, body: binary ? raw : raw ? JSON.parse(raw) : {} });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/files/upload-init") return res.end(JSON.stringify({ transferId: "u", chunkSize: 3, accepted: true, resumeFromByte: 0 }));
      if (req.url.startsWith("/api/files/upload-chunk")) return res.end(JSON.stringify({ nextOffset: seen.filter((item) => item.url.startsWith("/api/files/upload-chunk")).length * 3 }));
      if (req.url === "/api/files/upload-complete") return res.end(JSON.stringify({ status: "completed", sha256: seen.at(-1).body.sha256 || crypto.createHash("sha256").update("abcdef").digest("hex") }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-ul-"));
  const local = path.join(dir, "in.txt");
  await fs.writeFile(local, "abcdef", "utf8");
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port, chunkSizeBytes: 3 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
  try {
    const task = await client.uploadFile(local, "experiments/plans/in.txt");
    assert.equal(task.status, "completed");
    assert.equal(seen.filter((item) => item.url.startsWith("/api/files/upload-chunk")).length, 2);
    assert.deepEqual(seen.filter((item) => item.url.startsWith("/api/files/upload-chunk")).map((item) => item.body.length), [3, 3]);
    assert.equal(seen[0].url, "/api/files/upload-init");
    assert.equal(seen.at(-1).url, "/api/files/upload-complete");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
