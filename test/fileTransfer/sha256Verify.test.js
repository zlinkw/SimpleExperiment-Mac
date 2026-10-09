const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");
const source = fsSync.readFileSync(path.join(__dirname, "../../src/tunnel/FileTransferVerifier.ts"), "utf8");

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

test("download verify uses sha256 header", async () => {
  const body = Buffer.from("metric,value\nacc,1\n");
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("X-Simple-File-Sha256", sha.toUpperCase());
    res.end(body);
  });
  await listen(server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-sha-"));
  const target = path.join(dir, "metrics.csv");
  try {
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: server.address().port }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
    const task = await client.download("results/metrics.csv", target);
    const verify = await client.verify(task.transferId);
    assert.equal(verify.ok, true);
    assert.equal(verify.actualSha256, sha);
  } finally {
    server.close();
  }
});

test("sha256 verification reuses normalized digests and comparison", () => {
  const verifier = functionSource("verifyLocalFileSha256");
  assert.equal((verifier.match(/actualSha256\.toLowerCase\(\)/g) || []).length, 1);
  assert.equal((verifier.match(/expectedSha256\.toLowerCase\(\)/g) || []).length, 1);
  assert.match(verifier, /const ok = normalizedActualSha256 === normalizedExpectedSha256/);
  assert.match(verifier, /\n    ok,/);
  assert.match(verifier, /message: ok \? "sha256 ok" : "sha256 mismatch"/);
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
