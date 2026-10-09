const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadProgressDom() {
  const sourcePath = path.join(__dirname, "../../src/features/PanelProgressDom.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(code, { exports: loaded.exports, module: loaded, Object, Number, String, Math, Boolean });
  return loaded.exports.patchPanelProgressDom;
}

const patchPanelProgressDom = loadProgressDom();

function node(text = "") {
  const attrs = new Map();
  const classes = new Set();
  return {
    textContent: text,
    hidden: false,
    value: 0,
    max: 100,
    style: { width: "" },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) || null; },
    hasClass(name) { return classes.has(name); },
  };
}

test("execution progress patch updates existing text, status class, meter and visibility in place", () => {
  const status = node("运行中");
  const progress = node("");
  progress.hidden = true;
  const meter = node("");
  const root = {
    querySelector(selector) {
      return {
        "[data-status]": status,
        "[data-progress]": progress,
        "progress": meter,
      }[selector] || null;
    },
  };
  status.classList.add("status-queued");
  const changed = patchPanelProgressDom(root, {
    text: { "[data-status]": "测试中", "[data-progress]": "第 4 / 20 轮" },
    classes: [{ selector: "[data-status]", remove: ["status-queued"], add: ["status-running"] }],
    meters: [{ selector: "progress", value: 40, max: 100 }],
    visibility: [{ selector: "[data-progress]", hidden: false }],
  });
  assert.equal(status.textContent, "测试中");
  assert.equal(status.hasClass("status-queued"), false);
  assert.equal(status.hasClass("status-running"), true);
  assert.equal(progress.textContent, "第 4 / 20 轮");
  assert.equal(progress.hidden, false);
  assert.equal(meter.value, 40);
  assert.equal(meter.style.width, "40%");
  assert.ok(changed >= 6);
  assert.equal(patchPanelProgressDom(root, { text: { "[data-status]": "测试中" } }), 0, "unchanged values do not cause writes");
});

test("panel execution rendering wires bounded progress patches without rebuilding stable operation rows", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  assert.match(source, /function patchExecutionProgressDom\(state\)/);
  assert.match(source, /patchPanelProgressDom\(node, \{/);
  assert.match(source, /data-operation-render-key=/);
  assert.match(source, /data-task-render-key=/);
  assert.match(source, /operationRenderStructureStatus\(row\.status \|\| row\.state\)/);
});
