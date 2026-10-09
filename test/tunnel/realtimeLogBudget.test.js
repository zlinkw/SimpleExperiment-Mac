const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { applyRealtimeEvent, createRealtimeState, compactRealtimeLogs, REALTIME_LOG_RECORD_LIMIT, REALTIME_LOG_TEXT_LIMIT } = require("../../dist/tunnel/RealtimeEventReducer.js");
const { readSource } = require("../_helpers/sourceReader");

test("realtime log tails are capped by record count and tail size", () => {
  let state = createRealtimeState();
  const longText = "x".repeat(REALTIME_LOG_TEXT_LIMIT + 200);
  for (let i = 1; i <= REALTIME_LOG_RECORD_LIMIT + 8; i++) {
    state = applyRealtimeEvent(state, {
      schemaVersion: 1,
      seq: i,
      type: "log_tail",
      generatedAt: `2026-07-05T00:00:${String(i).padStart(2, "0")}Z`,
      source: "hub_agent",
      runKey: `run-${i}`,
      payload: { text: longText, offset: i },
    });
  }
  assert.equal(Object.keys(state.logs).length, REALTIME_LOG_RECORD_LIMIT);
  assert.equal(Boolean(state.logs["run-1"]), false);
  assert.equal(Boolean(state.logs[`run-${REALTIME_LOG_RECORD_LIMIT + 8}`]), true);
  assert.match(state.logs[`run-${REALTIME_LOG_RECORD_LIMIT + 8}`].text, /已截断较早日志/);
  assert.ok(state.logs[`run-${REALTIME_LOG_RECORD_LIMIT + 8}`].text.length <= REALTIME_LOG_TEXT_LIMIT + 64);
});

test("extension and multi endpoint clients compact logs before webview state", () => {
  const root = path.resolve(__dirname, "..", "..");
  const extension = readSource("src/extension.ts");
  const multi = readSource("src/tunnel/MultiEndpointRealtimeClient.ts");
  assert.match(extension, /updateCompactPanelLogsProjection\(firstRecord\(state\?\.logs\)\)/);
  assert.match(extension, /compactRealtimeLogs\)\(source, undefined, undefined, this\.logProtectedKeys\(\)\)/);
  assert.match(multi, /compactRealtimeLogs\(\{/);
});

test("compactRealtimeLogs keeps latest seq entries", () => {
  const logs = {};
  for (let i = 0; i < 45; i++) logs[`k-${i}`] = { text: `log-${i}`, seq: i };
  const compact = compactRealtimeLogs(logs, 3, 20);
  assert.deepEqual(Object.keys(compact), ["k-44", "k-43", "k-42"]);
});
