const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("communication topology explains telemetry and file transfer boundaries", () => {
  assert.match(panel, /\["Worker -> Hub", "可用性批量上报"\]/);
  assert.match(panel, /\["Worker -> 本机", "实时日志\/GPU\/任务（WebSocket\/SSE；快照备用）"\]/);
  assert.match(panel, /\["SFTP 文件", "低频代码\/配置\/结果\/日志包"\]/);
  assert.doesNotMatch(panel, /\["Worker -> Hub", "availability"\]/);
});
