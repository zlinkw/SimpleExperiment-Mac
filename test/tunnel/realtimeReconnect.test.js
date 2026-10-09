const test = require("node:test");
const assert = require("node:assert/strict");
const { readSource } = require("../_helpers/sourceReader");

const { RealtimeReconnect } = require("../../dist/tunnel/RealtimeReconnect.js");
const { defaultRealtimeRefreshPolicy } = require("../../dist/tunnel/RealtimeTunnelClient.js");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("reconnect backoff uses bounded jitter", () => {
  const reconnect = new RealtimeReconnect(
    { reconnectInitialDelaySeconds: 4, reconnectMaxDelaySeconds: 60 },
    () => 1,
  );

  assert.equal(reconnect.nextDelayMs(), 5000);
  assert.equal(reconnect.nextDelayMs(), 10000);
  assert.equal(reconnect.nextDelayMs(), 20000);
});

test("reconnect jitter is positive and never shortens retry delay", () => {
  const reconnect = new RealtimeReconnect(
    { reconnectInitialDelaySeconds: 4, reconnectMaxDelaySeconds: 60 },
    () => 0,
  );

  assert.equal(reconnect.nextDelayMs(), 4000);
  assert.equal(reconnect.nextDelayMs(), 8000);
  assert.equal(reconnect.nextDelayMs(), 16000);
});

test("snapshot fallback defaults to the bounded five-second interval", () => {
  assert.equal(defaultRealtimeRefreshPolicy.snapshotFallbackIntervalSeconds, 5);
});

test("transient loss has automatic retry policy and ordinary UI asks only to refresh status", () => {
  assert.equal(defaultRealtimeRefreshPolicy.reconnectInitialDelaySeconds, 3);
  assert.equal(defaultRealtimeRefreshPolicy.reconnectMaxDelaySeconds, 60);
  const panel = readSource("src/ui/PanelHtml.legacy.ts");
  assert.doesNotMatch(panel, /data-command="resumeStream"[^>]*>重新连接/);
  assert.match(panel, /执行结果待确认；实时连接会自动重试/);
  assert.match(panel, /label: "刷新运行状态", command: "snapshot"/);
  assert.match(renderPanelHtml(), /实时连接会自动重试/);
});
