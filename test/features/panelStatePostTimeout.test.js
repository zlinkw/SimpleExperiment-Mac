const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/features/PanelStateDelivery.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(code, { exports: loaded.exports, module: loaded });

test("a hung state post times out with fake timers and ignores a late resolution", async () => {
  const timers = new Map();
  let next = 0;
  const api = { setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  let resolvePost;
  const pending = loaded.exports.postMessageWithTimeout(() => new Promise(resolve => { resolvePost = resolve; }), 7000, api);
  await Promise.resolve();
  assert.equal(timers.size, 1);
  const [[id, timer]] = timers;
  assert.equal(timer.ms, 7000);
  timers.delete(id);
  timer.callback();
  await assert.rejects(pending, /timed out/);
  resolvePost(true);
  await Promise.resolve();
  assert.equal(timers.size, 0);
});

test("false or rejected postMessage is not counted as delivered", async () => {
  const api = { setTimeout(callback) { const id = setTimeout(callback, 5000); id.unref?.(); return id; }, clearTimeout(id) { clearTimeout(id); } };
  assert.equal(await loaded.exports.postMessageWithTimeout(() => Promise.resolve(false), 5000, api), false);
  await assert.rejects(() => loaded.exports.postMessageWithTimeout(() => Promise.reject(new Error("rejected")), 5000, api), /rejected/);
});
