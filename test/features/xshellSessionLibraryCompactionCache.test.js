const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadCompaction() {
  const sandbox = {
    XSHELL_SESSION_WEBVIEW_LIMIT: 2,
    XSHELL_SESSION_WEBVIEW_VARIANT_CACHE_LIMIT: 4,
    xshellSessionLibraryForWebviewCache: new WeakMap(),
    publicCalls: 0,
    uniqueStrings(values) {
      return [...new Set(values.filter(Boolean))];
    },
    localPathKey(value) {
      return String(value || "").replace(/\\/g, "/").toLowerCase();
    },
    publicXshellSessionForWebview(session) {
      sandbox.publicCalls += 1;
      return { name: session.name, filePath: session.filePath };
    },
    compactSensitiveText(value, limit) {
      return String(value || "").slice(0, limit);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("isWeakMapCacheKey")}\n${extractFunction("compactXshellSessionLibraryForWebview")}\nthis.compact = compactXshellSessionLibraryForWebview;`, sandbox);
  return sandbox;
}

function fixture() {
  return {
    library: {
      searchedDirs: ["C:/sessions"],
      existingDirs: ["C:/sessions"],
      sessions: [
        { name: "ordinary-1", filePath: "C:/sessions/ordinary-1.xsh" },
        { name: "ordinary-2", filePath: "C:/sessions/ordinary-2.xsh" },
        { name: "ordinary-3", filePath: "C:/sessions/ordinary-3.xsh" },
        { name: "protected", filePath: "C:/sessions/protected.xsh" },
      ],
    },
    setup: {
      savedSessionPath: "C:/sessions/protected.xsh",
      agentSessionPath: "",
      workerTunnels: [],
    },
  };
}

test("Xshell session library compaction reuses stable sources and keeps protected sessions", () => {
  const sandbox = loadCompaction();
  const { library, setup } = fixture();
  const first = sandbox.compact(library, setup, "warning");
  const publicCalls = sandbox.publicCalls;

  assert.strictEqual(sandbox.compact(library, setup, "warning"), first);
  assert.equal(sandbox.publicCalls, publicCalls);
  assert.deepEqual(Array.from(first.sessions, (session) => session.name), ["ordinary-1", "ordinary-2", "protected"]);
  assert.equal(first.totalCount, 4);
  assert.equal(first.visibleCount, 3);
  assert.equal(first.omittedCount, 1);
  assert.equal(first.error, "warning");
});

test("Xshell session library compaction invalidates on library and setup replacement", () => {
  const sandbox = loadCompaction();
  const { library, setup } = fixture();
  const first = sandbox.compact(library, setup, "");
  const setupReplacement = { ...setup, savedSessionPath: "", workerTunnels: [] };
  const withoutProtected = sandbox.compact(library, setupReplacement, "");
  const libraryReplacement = { ...library, sessions: [...library.sessions] };
  const replacedLibrary = sandbox.compact(libraryReplacement, setup, "");

  assert.notStrictEqual(withoutProtected, first);
  assert.notStrictEqual(replacedLibrary, first);
  assert.deepEqual(Array.from(withoutProtected.sessions, (session) => session.name), ["ordinary-1", "ordinary-2"]);
  assert.deepEqual(Array.from(replacedLibrary.sessions, (session) => session.name), ["ordinary-1", "ordinary-2", "protected"]);
});

test("Xshell session library compaction keeps only bounded error variants", () => {
  const sandbox = loadCompaction();
  const { library, setup } = fixture();
  const oldest = sandbox.compact(library, setup, "error-0");
  for (let index = 1; index < 6; index += 1) {
    sandbox.compact(library, setup, `error-${index}`);
  }
  const variants = sandbox.xshellSessionLibraryForWebviewCache.get(library).get(setup);
  assert.equal(variants.size, 4);
  assert.notStrictEqual(sandbox.compact(library, setup, "error-0"), oldest);
  assert.equal(variants.size, 4);
});
