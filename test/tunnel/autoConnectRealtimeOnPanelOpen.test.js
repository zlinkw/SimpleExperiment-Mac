const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("webview panel open auto connects realtime stream", () => {
  const source = readSource("src/extension.ts");
  const resolve = source.slice(source.indexOf("resolveWebviewView(webviewView)"), source.indexOf("private disposeResolvedWebviewView"));
  const connect = source.slice(source.indexOf("async ensureRealtimeConnected"), source.indexOf("private startAvailabilityPushLoop"));
  assert.match(resolve, /void this\.ensureRealtimeConnected\("webview resolved"\)/);
  assert.match(connect, /await client\.connect\(undefined, \{ manual:/);
  assert.doesNotMatch(source, /this\.client\.connect\(this\.lastRealtimeState\?\.lastSeq \|\| 0\)/);
  assert.match(connect, /this\.budget\.isPaused\(\)/);
});

test("test tunnel and resume network auto reconnect realtime", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /ensureRealtimeConnected\("tunnel test ok"\)/);
  assert.match(source, /ensureRealtimeConnected\("resume network"\)/);
  assert.match(source, /disconnect\("paused"\)/);
});
