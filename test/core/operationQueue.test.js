const test = require("node:test");
const assert = require("node:assert/strict");

const { OperationQueue } = require("../../dist/core/OperationQueue.js");

test("manual cancellation stays cancelled when the operation rejects on abort", async () => {
  const queue = new OperationQueue();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const operation = queue.enqueue({
    id: "manual-cancel",
    type: "test",
    priority: "manual",
    cancellable: true,
    run: (signal) => new Promise((resolve, reject) => {
      markStarted();
      signal.addEventListener("abort", () => reject(new Error("aborted by user")), { once: true });
    }),
  });

  await started;
  assert.equal(queue.cancel("manual-cancel"), true);
  await assert.rejects(operation, /aborted by user/);
  const record = queue.snapshot().find((item) => item.id === "manual-cancel");
  assert.equal(record.status, "cancelled");
  assert.equal(record.error, undefined);
});

test("manual cancellation remains terminal when work ignores the abort signal", async () => {
  const queue = new OperationQueue();
  let finish;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const operation = queue.enqueue({
    id: "cancel-ignored",
    type: "test",
    priority: "manual",
    cancellable: true,
    run: () => new Promise((resolve) => {
      finish = resolve;
      markStarted();
    }),
  });

  await started;
  assert.equal(queue.cancel("cancel-ignored"), true);
  finish();
  await operation;
  assert.equal(queue.snapshot().find((item) => item.id === "cancel-ignored").status, "cancelled");
});

test("timeout retains the exclusive key until underlying work settles, then differs from manual cancellation", async () => {
  const queue = new OperationQueue();
  let finish;
  let aborted;
  const abortSeen = new Promise(resolve => { aborted = resolve; });
  const operation = queue.enqueue({
    id: "timed-out",
    type: "test",
    priority: "background",
    timeoutMs: 5,
    exclusiveKeys: ["timed-resource"],
    run: signal => new Promise(resolve => {
      finish = resolve;
      signal.addEventListener("abort", aborted, { once: true });
    }),
  });
  const rejection = assert.rejects(operation, /operation timed out/);
  await abortSeen;
  assert.equal(queue.snapshot().find(item => item.id === "timed-out").status, "cancelling");
  assert.equal(queue.activeExclusiveKeys().has("timed-resource"), true);
  finish();
  await rejection;
  assert.equal(queue.snapshot().find((item) => item.id === "timed-out").status, "timeout");
  assert.equal(queue.activeExclusiveKeys().has("timed-resource"), false);
});

test("completed operation history is bounded while preserving newest records", async () => {
  const queue = new OperationQueue(3);
  for (let index = 0; index < 6; index += 1) {
    await queue.enqueue({
      id: `operation-${index}`,
      type: "test",
      priority: "background",
      run: async () => undefined,
    });
  }

  assert.deepEqual(queue.snapshot(50).map((item) => item.id), ["operation-3", "operation-4", "operation-5"]);
});

test("exclusive key index preserves priority order without rescanning running operations", async () => {
  const queue = new OperationQueue();
  const starts = [];
  let releaseFirst;
  const first = queue.enqueue({
    id: "first",
    type: "test",
    priority: "manual",
    exclusiveKeys: ["server:a"],
    run: () => new Promise((resolve) => {
      starts.push("first");
      releaseFirst = resolve;
    }),
  });
  const background = queue.enqueue({
    id: "background",
    type: "test",
    priority: "background",
    exclusiveKeys: ["server:a"],
    run: async () => { starts.push("background"); },
  });
  const blocking = queue.enqueue({
    id: "blocking",
    type: "test",
    priority: "user_blocking",
    exclusiveKeys: ["server:a"],
    run: async () => { starts.push("blocking"); },
  });

  assert.deepEqual([...queue.activeExclusiveKeys()], ["server:a"]);
  assert.deepEqual(starts, ["first"]);
  releaseFirst();
  await Promise.all([first, background, blocking]);
  assert.deepEqual(starts, ["first", "blocking", "background"]);
  assert.deepEqual([...queue.activeExclusiveKeys()], []);
});

test("operation queue keeps direct indexes for records and active exclusive keys", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../src/core/OperationQueue.ts"), "utf8");
  assert.match(source, /latestRecordById = new Map/);
  assert.match(source, /activeExclusiveKeyCounts = new Map/);
  assert.doesNotMatch(source, /\[\.\.\.this\.records\]\.reverse\(\)\.find|for \(const item of this\.running\.values\(\)\)/);
});

test("history trimming preserves an active record and duplicate IDs cannot schedule concurrently", async () => {
  const queue = new OperationQueue(1);
  let releaseFirst;
  const first = queue.enqueue({
    id: "duplicate",
    type: "long",
    priority: "manual",
    run: () => new Promise((resolve) => { releaseFirst = resolve; }),
  });
  await assert.rejects(queue.enqueue({
    id: "duplicate",
    type: "short",
    priority: "manual",
    run: async () => undefined,
  }), error => error.code === "OPERATION_ALREADY_ACTIVE");
  await queue.enqueue({ id: "other", type: "short", priority: "manual", run: async () => undefined });

  assert.deepEqual(queue.snapshot(10).map((item) => [item.type, item.status]), [["long", "running"]]);
  releaseFirst();
  await first;
  assert.deepEqual(queue.snapshot(10).map((item) => [item.type, item.status]), [["long", "succeeded"]]);
  await queue.enqueue({ id: "duplicate", type: "retry", priority: "manual", run: async () => undefined });
  assert.deepEqual(queue.snapshot(10).map(item => [item.type, item.status]), [["retry", "succeeded"]]);
});
