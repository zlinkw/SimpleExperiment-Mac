"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { fork } = require("node:child_process");
test("two real extension-host processes cannot reserve the same PLAN concurrently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-retention-processes-"));
  const children = [], logs = [];
  const timeout = setTimeout(() => children.forEach(child => child.kill()), 9000);
  try {
    const launches = ["left", "right"].map(id => {
      const child = fork(path.join(__dirname, "../fixtures/retention-claim-worker.js"), [root, id],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      let readyResolve, resultResolve, reject;
      const ready = new Promise((resolve, fail) => { readyResolve = resolve; reject = fail; });
      const result = new Promise(resolve => { resultResolve = resolve; });
      child.stdout.on("data", data => logs.push(String(data)));
      child.stderr.on("data", data => logs.push(String(data)));
      child.on("message", message => { if (message.ready) readyResolve(); else resultResolve(message); });
      child.on("error", reject);
      child.on("exit", code => { if (code !== 0) reject(new Error("worker exit " + code + "\n" + logs.join(""))); });
      return { child, ready, result };
    });
    await Promise.all(launches.map(row => row.ready));
    launches.forEach(row => row.child.send("start"));
    const outcomes = await Promise.all(launches.map(row => row.result));
    assert.equal(outcomes.filter(row => row.ok).length, 1, JSON.stringify(outcomes) + logs.join(""));
    assert.match(outcomes.find(row => !row.ok).message, /另一扩展主机实例/);
    const claims = JSON.parse(fs.readFileSync(path.join(root, "simple_cluster/.simple-retention-admission.json"), "utf8")).claims;
    assert.equal(claims.length, 1);
    assert.equal(claims[0].incomingRun, outcomes.find(row => row.ok).id);
  } finally {
    clearTimeout(timeout);
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve); child.send("done");
    })));
  }
});
