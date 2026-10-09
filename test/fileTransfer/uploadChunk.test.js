const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("chunk upload sends init binary chunks and complete", async () => {
  const chunks = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (chunk) => parts.push(chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const raw = Buffer.concat(parts);
      if (req.url === "/api/files/upload-init") {
        const body = JSON.parse(raw.toString("utf8"));
        assert.equal(body.remotePath, "experiments/presets/a.json");
        return res.end(JSON.stringify({ schemaVersion: 1, transferId: "u1", chunkSize: 2, accepted: true, resumeFromByte: 0 }));
      }
      if (req.url.startsWith("/api/files/upload-chunk")) {
        chunks.push(raw.toString("utf8"));
        const offset = Number(new URL(`http://x${req.url}`).searchParams.get("offset"));
        return res.end(JSON.stringify({ schemaVersion: 1, transferId: "u1", receivedBytes: raw.length, nextOffset: offset + raw.length }));
      }
      const sha = crypto.createHash("sha256").update("abcdef").digest("hex");
      res.end(JSON.stringify({ schemaVersion: 1, transferId: "u1", status: "completed", remotePath: "experiments/presets/a.json", size: 6, sha256: sha }));
    });
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-upload-"));
  const local = path.join(dir, "a.json");
  await fs.writeFile(local, "abcdef");
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port, chunkSizeBytes: 2 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    const task = await client.upload(local, "experiments/presets/a.json");
    assert.equal(task.status, "completed");
    assert.deepEqual(chunks, ["ab", "cd", "ef"]);
  } finally {
    server.close();
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }