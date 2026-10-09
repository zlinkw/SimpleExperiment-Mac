const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("webview action commands use strict allowlist and fixed tunnel action map", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /type WebviewActionCommand/);
  assert.match(source, /const uiActionCommands = new Set<WebviewActionCommand>/);
  assert.match(source, /const actionCommandMap/);
  assert.match(source, /function getSafeCommand/);
  assert.doesNotMatch(source, /\| "(?:listRemoteFiles|downloadRemoteFile|uploadRemoteFile|selectRemoteFile)"/);
  assert.doesNotMatch(source, /apiPath|shellCommand|remoteCommand/);
});
