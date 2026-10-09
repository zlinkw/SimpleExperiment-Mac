const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadLivePills() {
  const sandbox = {
    TASK_LIVE_STATUS_TOKENS: new Set(["running", "testing"]),
    taskStatusToken: (status) => String(status || "").trim().toLowerCase(),
    compactText: (value, maxLength) => {
      const text = String(value === undefined || value === null || value === "" ? "-" : value);
      const limit = Math.max(8, Number(maxLength) || 42);
      return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
    },
    arrayText: (value) => (Array.isArray(value) ? value.join(", ") : value),
    workerName: (value) => String(value || "-").trim(),
    esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("taskLivePills")}\nthis.pills = taskLivePills;`, sandbox);
  return sandbox.pills;
}

test("live task rows surface progress, worker and GPU without a meta grid", () => {
  const pills = loadLivePills();
  const html = pills({ status: "running", progress: "epoch 12/50", serverId: "worker-a", gpuIds: [0, 1] });

  assert.match(html, /data-task-progress-value="true">epoch 12\/50<\/span>/);
  assert.match(html, /worker-a/);
  assert.match(html, /GPU 0, 1/);
  assert.equal(html.split("taskLivePill").length - 1, 3);
  assert.doesNotMatch(html, /taskMetaGrid/);
  assert.match(html, /title="进度：epoch 12\/50"/);
});

test("terminal and queued task rows stay compact", () => {
  const pills = loadLivePills();
  for (const status of ["completed", "failed", "queued", "stopped", "unknown", ""]) {
    assert.equal(pills({ status, progress: "epoch 3", serverId: "worker-a", gpuIds: [0] }), "", `status ${status} must stay compact`);
  }
  assert.equal(pills(null), "");
  assert.equal(pills(undefined), "");
});

test("live pills omit fields the scheduler did not report", () => {
  const pills = loadLivePills();
  assert.equal(pills({ status: "running" }), "");
  assert.equal(pills({ status: "testing", progress: "-", serverId: "-", gpuIds: "-" }), "");

  const progressOnly = pills({ status: "running", progress: "step 40", serverId: "-", gpuIds: "-" });
  assert.equal(progressOnly.split("taskLivePill").length - 1, 1);
  assert.match(progressOnly, /data-task-progress-value="true">step 40<\/span>/);

  const placementOnly = pills({ status: "testing", serverId: "worker-b", gpuIds: [2] });
  assert.equal(placementOnly.split("taskLivePill").length - 1, 2);
  assert.match(placementOnly, /title="Worker：worker-b；GPU 2"/);
});

test("render budget notice explains the folding order", () => {
  const renderer = extractFunction("renderTaskCards");
  assert.match(renderer, /TASK_RENDER_BUDGET_HINT/);
  assert.match(renderer, /优先显示已选、运行与失败/);

  const hint = /const TASK_RENDER_BUDGET_HINT = "([^"]+)"/.exec(panelSource);
  assert.ok(hint, "missing TASK_RENDER_BUDGET_HINT");
  assert.match(hint[1], /已选/);
  assert.match(hint[1], /排队/);
  assert.match(hint[1], /仍参与计数与批量操作/);
});

test("task card head wires live pills and keeps the compact contract", () => {
  const card = extractFunction("renderTaskCard");
  assert.match(card, /taskLivePills\(row\)/);
  assert.doesNotMatch(card, /taskMetaGrid/);
  assert.match(card, /titleBits/);
  assert.match(panelSource, /\.pill\.taskLivePill \{/);
});
