const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

// Read the emitted webview script, not the TypeScript template source: path
// normalization relies on backslash escapes that only collapse once rendered.
const panel = renderPanelHtml();

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadSessionIndex(sessions) {
  const sandbox = {
    EMPTY_XSHELL_SESSIONS: [],
    xshellSessionIndexCacheSource: null,
    xshellSessionIndexCacheValue: null,
    lastState: sessions === undefined ? {} : { xshellSessions: { sessions } },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("sessionPathKey"),
    extractFunction("xshellSessionPathIndex"),
    extractFunction("sessionForPath"),
    extractFunction("samePath"),
    "this.pathIndex = xshellSessionPathIndex;",
    "this.forPath = sessionForPath;",
    "this.samePath = samePath;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("session lookup resolves case-insensitively across separator styles", () => {
  const hub = { filePath: "C:\\Users\\ZLK\\Documents\\NetSarang\\Xshell\\Sessions\\hub.xsh", host: "hub" };
  const worker = { filePath: "C:/Users/ZLK/Documents/NetSarang/Xshell/Sessions/worker-a.xsh", host: "worker-a" };
  const sandbox = loadSessionIndex([hub, worker]);

  assert.equal(sandbox.forPath("C:/Users/ZLK/Documents/NetSarang/Xshell/Sessions/hub.xsh"), hub);
  assert.equal(sandbox.forPath("c:\\users\\ZLK\\documents\\netsarang\\xshell\\sessions\\HUB.xsh"), hub);
  assert.equal(sandbox.forPath("C:\\Users\\ZLK\\Documents\\NetSarang\\Xshell\\Sessions\\worker-a.xsh"), worker);
  assert.equal(sandbox.forPath("C:/missing.xsh"), undefined);
});

test("session index is built once per sessions array and invalidates on replacement", () => {
  const first = { filePath: "C:/sessions/a.xsh" };
  const sessions = [first];
  const sandbox = loadSessionIndex(sessions);

  const index = sandbox.pathIndex();
  assert.equal(sandbox.pathIndex(), index);
  assert.equal(sandbox.forPath("C:/sessions/a.xsh"), first);

  const replacement = { filePath: "C:/sessions/b.xsh" };
  sandbox.lastState = { xshellSessions: { sessions: [replacement] } };
  assert.notEqual(sandbox.pathIndex(), index);
  assert.equal(sandbox.forPath("C:/sessions/b.xsh"), replacement);
  assert.equal(sandbox.forPath("C:/sessions/a.xsh"), undefined);
});

test("first matching session wins for duplicate paths", () => {
  const first = { filePath: "C:/sessions/dup.xsh", host: "first" };
  const second = { filePath: "C:\\sessions\\DUP.xsh", host: "second" };
  const sandbox = loadSessionIndex([first, second]);
  assert.equal(sandbox.forPath("C:/sessions/dup.xsh").host, "first");
});

test("missing or empty session state keeps lookups safe", () => {
  const empty = loadSessionIndex(undefined);
  assert.equal(empty.forPath("C:/sessions/a.xsh"), undefined);
  assert.equal(empty.pathIndex().size, 0);
  assert.equal(empty.pathIndex(), empty.pathIndex());

  const malformed = loadSessionIndex("not-an-array");
  assert.equal(malformed.forPath("C:/sessions/a.xsh"), undefined);

  const blanks = loadSessionIndex([{ filePath: "" }, null, { host: "no-path" }]);
  assert.equal(blanks.pathIndex().size, 0);
  assert.equal(blanks.forPath(""), undefined);
  assert.equal(blanks.forPath(null), undefined);
});

test("samePath keeps its falsy and normalization contract", () => {
  const sandbox = loadSessionIndex([]);
  assert.equal(sandbox.samePath("C:\\a\\b.xsh", "c:/A/B.xsh"), true);
  assert.equal(sandbox.samePath("C:/a.xsh", "C:/b.xsh"), false);
  assert.equal(sandbox.samePath("", "C:/a.xsh"), false);
  assert.equal(sandbox.samePath("C:/a.xsh", null), false);
  assert.equal(sandbox.samePath(undefined, undefined), false);
});
