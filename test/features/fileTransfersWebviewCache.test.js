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
  const empty = Object.freeze({});
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);
  const sandbox = {
    WEBVIEW_FILE_TRANSFER_ACTIVE_LIMIT: 2,
    WEBVIEW_FILE_TRANSFER_TERMINAL_LIMIT: 1,
    EMPTY_FILE_TRANSFERS_FOR_WEBVIEW: empty,
    fileTransfersForWebviewCache: new WeakMap(),
    compactCalls: 0,
    terminalChecks: 0,
    fileTransferEntries(fileTransfers) {
      if (Array.isArray(fileTransfers)) return fileTransfers.map((row, index) => [String(row.id || index), row]);
      return Object.entries(fileTransfers || {});
    },
    WEBVIEW_FILE_TRANSFER_TERMINAL_STATUSES: {
      has(status) {
        sandbox.terminalChecks += 1;
        return terminalStatuses.has(status);
      },
    },
    rowTimeForWebview(row) {
      return Date.parse(String(row.updatedAt || "")) || Number(row.seq || 0);
    },
    compactFileTransferForWebview(id, row) {
      sandbox.compactCalls += 1;
      return { transferId: id, status: row.status, updatedAt: row.updatedAt };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("isTerminalTransferForWebview")}\n${extractFunction("compactFileTransfersForWebview")}\nthis.compactTransfers = compactFileTransfersForWebview;\nthis.isTerminal = isTerminalTransferForWebview;`, sandbox);
  return sandbox;
}

test("file transfer Webview cache reuses stable snapshots", () => {
  const sandbox = loadCompaction();
  const transfers = {
    running: { status: "running", updatedAt: "2026-07-30T02:00:00Z" },
    done: { status: "completed", updatedAt: "2026-07-30T01:00:00Z" },
  };
  const first = sandbox.compactTransfers(transfers);
  const calls = sandbox.compactCalls;

  assert.strictEqual(sandbox.compactTransfers(transfers), first);
  assert.equal(sandbox.compactCalls, calls);
  assert.deepEqual(Object.keys(first), ["running", "done"]);
});

test("file transfer Webview cache invalidates when snapshot objects are replaced", () => {
  const sandbox = loadCompaction();
  const transfers = { running: { status: "running", updatedAt: "2026-07-30T01:00:00Z" } };
  const first = sandbox.compactTransfers(transfers);
  const replacement = { running: { status: "running", updatedAt: "2026-07-30T02:00:00Z" } };
  const second = sandbox.compactTransfers(replacement);

  assert.notStrictEqual(second, first);
  assert.equal(second.running.updatedAt, "2026-07-30T02:00:00Z");
});

test("file transfer Webview cache preserves active and terminal ordering limits", () => {
  const sandbox = loadCompaction();
  const transfers = {
    activeOld: { status: "running", updatedAt: "2026-07-30T01:00:00Z" },
    activeNew: { status: "queued", updatedAt: "2026-07-30T03:00:00Z" },
    activeMiddle: { status: "running", updatedAt: "2026-07-30T02:00:00Z" },
    doneOld: { status: "completed", updatedAt: "2026-07-29T01:00:00Z" },
    doneNew: { status: "failed", updatedAt: "2026-07-30T04:00:00Z" },
  };
  assert.doesNotMatch(extractFunction("compactFileTransfersForWebview"), /entries\s*\.filter\(/);
  const compacted = sandbox.compactTransfers(transfers);

  assert.equal(sandbox.terminalChecks, Object.keys(transfers).length);
  assert.deepEqual(Object.keys(compacted), ["activeNew", "activeMiddle", "doneNew"]);
  assert.equal(compacted.activeOld, undefined);
  assert.equal(compacted.doneOld, undefined);
});

test("empty file transfer inputs share the immutable empty result", () => {
  const sandbox = loadCompaction();

  assert.strictEqual(sandbox.compactTransfers(undefined), sandbox.EMPTY_FILE_TRANSFERS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactTransfers(null), sandbox.EMPTY_FILE_TRANSFERS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactTransfers({}), sandbox.EMPTY_FILE_TRANSFERS_FOR_WEBVIEW);
  assert.equal(sandbox.compactCalls, 0);
});

test("file transfer terminal classification reuses one fixed set", () => {
  const sandbox = loadCompaction();
  for (const status of ["completed", "failed", "cancelled", "canceled"]) assert.equal(sandbox.isTerminal({ status }), true, status);
  for (const status of ["running", "queued", "unknown", ""]) assert.equal(sandbox.isTerminal({ status }), false, status);
  assert.match(extension, /const WEBVIEW_FILE_TRANSFER_TERMINAL_STATUSES = new Set\(/);
  assert.match(extractFunction("isTerminalTransferForWebview"), /WEBVIEW_FILE_TRANSFER_TERMINAL_STATUSES\??\.has\(status\)/);
});
