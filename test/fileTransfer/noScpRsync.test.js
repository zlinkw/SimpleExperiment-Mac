const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("file transfer never invokes scp or rsync or ssh", async () => {
  const commands = [];
  const oldSpawn = childProcess.spawn;
  const oldExec = childProcess.exec;
  const oldExecFile = childProcess.execFile;
  childProcess.spawn = (cmd, ...args) => { commands.push(path.basename(String(cmd)).toLowerCase()); return oldSpawn(cmd, ...args); };
  childProcess.exec = (cmd, ...args) => { commands.push(path.basename(String(cmd).split(/\s+/)[0]).toLowerCase()); return oldExec(cmd, ...args); };
  childProcess.execFile = (cmd, ...args) => { commands.push(path.basename(String(cmd)).toLowerCase()); return oldExecFile(cmd, ...args); };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/api/files/list")) return res.end(JSON.stringify({ schemaVersion: 1, path: "results", entries: [] }));
      if (req.url.startsWith("/api/files/download")) {
        res.setHeader("Content-Type", "application/octet-stream");
        return res.end("csv");
      }
      if (req.url === "/api/files/upload-init") return res.end(JSON.stringify({ transferId: "u", chunkSize: 10, accepted: true, resumeFromByte: 0 }));
      if (req.url.startsWith("/api/files/upload-chunk")) return res.end(JSON.stringify({ nextOffset: 3 }));
      if (req.url === "/api/files/upload-complete") return res.end(JSON.stringify({ status: "completed", sha256: crypto.createHash("sha256").update("abc").digest("hex") }));
      res.end(JSON.stringify({ status: "completed" }));
    });
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-noscp-"));
  const local = path.join(dir, "preset.json");
  await fs.writeFile(local, "abc");
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
  try {
    await client.list("results/run");
    await client.download("results/a.csv", path.join(dir, "a.csv"));
    await client.upload(local, "experiments/presets/preset.json");
    await client.cancel("missing");
    assert.equal(commands.some((cmd) => ["ssh", "ssh.exe", "scp", "scp.exe", "rsync", "rsync.exe"].includes(cmd)), false);
  } finally {
    server.close();
    childProcess.spawn = oldSpawn;
    childProcess.exec = oldExec;
    childProcess.execFile = oldExecFile;
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
