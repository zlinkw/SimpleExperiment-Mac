const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("upload complete rejects sha256 mismatch", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Connection", "close");
      if (req.url === "/api/files/upload-init") return res.end(JSON.stringify({ transferId: "bad", chunkSize: 10, accepted: true, resumeFromByte: 0 }));
      if (req.url.startsWith("/api/files/upload-chunk")) return res.end(JSON.stringify({ receivedBytes: 3, nextOffset: 3 }));
      res.end(JSON.stringify({ status: "completed", sha256: crypto.createHash("sha256").update("wrong").digest("hex") }));
    });
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-complete-"));
  const local = path.join(dir, "preset.json");
  await fs.writeFile(local, "abc");
  let client;
  try {
    client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    await assert.rejects(client.upload(local, "experiments/presets/preset.json"), /SHA256/);
  } finally {
    await client?.dispose();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
