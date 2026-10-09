const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "..", "..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agent = readSource("src/clusterAgentRuntime.ts");

test("manual Worker reassignment is exposed only as a worker-pool task action", () => {
  assert.match(panel, /reassignWorkerTask/);
  assert.match(panel, /manualReassignSurfaceVisible\(row\)/);
  assert.match(panel, /topology\.mode === "worker_pool"/);
  assert.match(panel, /data-task-status/);
  assert.match(panel, /仅允许转移排队或未开始任务/);
});

test("manual Worker reassignment keeps an immutable source record and creates a new attempt", () => {
  const start = extension.indexOf("async reassignWorkerTaskFromUi");
  const end = extension.indexOf("async saveHubConfigFromUi", start);
  assert.ok(start >= 0 && end > start);
  const flow = extension.slice(start, end);
  assert.match(flow, /topology\.mode !== "worker_pool"/);
  assert.match(flow, /new Set\(\["queued", "pending"\]\)/);
  assert.match(flow, /probe\.status === "ok"/);
  assert.match(flow, /missingWorkerActionCapabilities\(worker\.id, "retry-worker-task"\)/);
  assert.match(flow, /showQuickPick/);
  assert.match(flow, /showWarningMessage\(detail, \{ modal: true \}, "确认手动转移"\)/);
  assert.match(flow, /body\.originalRunKey = runKey/);
  assert.match(flow, /body\.sourceWorkerId = sourceWorkerId/);
  assert.match(flow, /body\.targetWorkerId = picked\.workerId/);
  assert.match(flow, /body\.manualReassignment = true/);
  assert.match(flow, /postWorkerTunnelAction\(picked\.workerId, "retry-worker-task"/);
});

test("manual Worker reassignment crosses the webview and host command gates", () => {
  assert.match(extension, /case "reassignWorkerTask":\s*await this\.reassignWorkerTaskFromUi\(message\)/);
  assert.match(extension, /SAFE_WEBVIEW_COMMANDS = new Set\(\[[\s\S]*"reassignWorkerTask"/);
  assert.match(extension, /hostOperationUiCommands = new Set\(\[[\s\S]*"reassignWorkerTask"/);
  assert.match(extension, /reassignWorkerTask: "手动转移 Worker 任务"/);
});

test("Worker runtime retains manual reassignment provenance and target ownership", () => {
  assert.match(agent, /manual_reassignment = any\(action_bool/);
  assert.match(agent, /"resultOwnerWorkerId": worker_id/);
  assert.match(agent, /"sourceWorkerId": source_worker_id/);
  assert.match(agent, /"targetWorkerId": worker_id/);
  assert.match(agent, /"originalRunKey": original_run_key/);
  assert.match(agent, /"reassignmentRunKey": reassignment_run_key or command_id/);
  assert.match(agent, /append_event\(root, \{"type": "worker_task_started"[\s\S]*\{\*\*task, \*\*result\}/);
});
