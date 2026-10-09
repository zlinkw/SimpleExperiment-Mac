const test = require("node:test");
const assert = require("node:assert/strict");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");
const { isSafeRemotePath } = require("../../dist/tunnel/FileTransferTypes.js");

test("safe path rejects traversal absolute path and private key names", async () => {
  assert.equal(isSafeRemotePath("../secret"), false);
  assert.equal(isSafeRemotePath("C:/Users/ZLK/.ssh/id_rsa"), false);
  assert.equal(isSafeRemotePath("/etc/passwd"), false);
  assert.equal(isSafeRemotePath("experiments/plans/a.json"), true);
  const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: 65535 }, new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }));
  await assert.rejects(client.list("../secret"), /路径|SAFE|范围/);
});