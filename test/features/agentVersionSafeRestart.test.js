const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("Agent version mismatch preserves scheduler and GPU tmux sessions", () => {
  const extension = readSource("src/extension/legacy.ts");
  const start = extension.indexOf("async ensureRemoteAgentVersionConsistent()");
  const end = extension.indexOf("private scheduleBackgroundHealthProbe(", start);
  assert.ok(start >= 0 && end > start);
  const reconcile = extension.slice(start, end);
  assert.doesNotMatch(reconcile, /killRemoteAgentAndTmux|kill-stale-runtime|kill-session/);
  assert.match(reconcile, /agent_restart_required/);
  assert.match(reconcile, /准备 Agent 并启动/);
});
