const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeFileTransferRows,
  transferRateBytesPerSecond,
  transferEtaSeconds,
} = require("../../dist/ui/WebviewRenderState.js");

test("upload totals fall back to the handshake expectedSize", () => {
  const [row] = normalizeFileTransferRows([
    { transferId: "up-1", status: "running", expectedSize: 2000, transferredBytes: 500 },
  ]);
  assert.equal(row.totalBytes, 2000);
  assert.equal(row.percent, 25);
});

test("rate and eta are derived when the agent does not report them", () => {
  const [row] = normalizeFileTransferRows([
    {
      transferId: "up-2",
      status: "running",
      totalBytes: 1000,
      transferredBytes: 400,
      startedAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:10Z",
    },
  ]);
  assert.equal(row.speed, 40);
  assert.equal(row.eta, 15);
  assert.equal(row.percent, 40);
});

test("agent-reported rate and eta win over derived values", () => {
  const [row] = normalizeFileTransferRows([
    {
      transferId: "up-3",
      status: "running",
      totalBytes: 1000,
      transferredBytes: 400,
      startedAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:10Z",
      speed: 999,
      etaSeconds: 3,
      percent: 41.5,
    },
  ]);
  assert.equal(row.speed, 999);
  assert.equal(row.eta, 3);
  assert.equal(row.percent, 41.5);
});

test("derivation stays quiet when the inputs cannot support it", () => {
  const [noTotal] = normalizeFileTransferRows([{ transferId: "x", transferredBytes: 100 }]);
  assert.equal(noTotal.totalBytes, 0);
  assert.equal(noTotal.percent, undefined);
  assert.equal(noTotal.eta, "-");

  const [noStamps] = normalizeFileTransferRows([{ transferId: "y", totalBytes: 10, transferredBytes: 5 }]);
  assert.equal(noStamps.speed, "-");
  assert.equal(noStamps.eta, "-");
  assert.equal(noStamps.percent, 50);

  assert.equal(transferRateBytesPerSecond(0, "2026-07-26T10:00:00Z", "2026-07-26T10:00:10Z"), undefined);
  assert.equal(transferRateBytesPerSecond(100, "not-a-time", "2026-07-26T10:00:10Z"), undefined);
  assert.equal(transferRateBytesPerSecond(100, "2026-07-26T10:00:10Z", "2026-07-26T10:00:10Z"), undefined);
  assert.equal(transferEtaSeconds(100, 100, 10), undefined);
  assert.equal(transferEtaSeconds(100, 50, 10), undefined);
  assert.equal(transferEtaSeconds(10, 100, 0), undefined);
});

test("stall flag is carried through and defaults to false", () => {
  const [stalled] = normalizeFileTransferRows([{ transferId: "s1", status: "running", stalled: true }]);
  assert.equal(stalled.stalled, true);
  const [live] = normalizeFileTransferRows([{ transferId: "s2", status: "running" }]);
  assert.equal(live.stalled, false);
});

test("existing alias handling is preserved", () => {
  const rows = normalizeFileTransferRows({
    tx1: {
      direction: "download",
      remote_path: "/remote/a.txt",
      local_path: "D:/a.txt",
      state: "completed",
      transferred_bytes: 10,
      total_bytes: 10,
      speed_bytes_per_second: 100,
      eta_seconds: 0,
    },
  });
  assert.equal(rows[0].transferId, "tx1");
  assert.equal(rows[0].remotePath, "/remote/a.txt");
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].transferredBytes, 10);
  assert.equal(rows[0].percent, 100);
  assert.equal(rows[0].speed, 100);
});
