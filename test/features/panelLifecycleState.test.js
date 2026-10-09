const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/features/PanelLifecycle.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(code, { exports: loaded.exports, module: loaded });

test("lifecycle allows recovery paths but never returns from reload-required or disposed", () => {
  const transition = loaded.exports.transitionPanelLifecycle;
  assert.equal(transition("detached", "booting").state, "booting");
  assert.equal(transition("booting", "ready").state, "ready");
  assert.equal(transition("ready", "maintenance").state, "maintenance");
  assert.equal(transition("maintenance", "ready").state, "ready");
  assert.equal(transition("ready", "reload_required").state, "reload_required");
  assert.equal(transition("reload_required", "ready").allowed, false);
  assert.equal(transition("disposed", "booting").allowed, false);
});
