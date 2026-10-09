const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name) {
  const start = extension.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = extension.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return extension.slice(start, end + 1);
}

function loadStatusHelpers() {
  const sandbox = {
    stringFromRecord: (record, keys) => {
      for (const key of keys) {
        const value = record && record[key];
        if (value !== undefined && value !== null && String(value).trim()) return String(value);
      }
      return "";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("SFTP_UPLOAD_FAILURE_STATUSES"),
    extractConst("SFTP_UPLOAD_SUCCESS_STATUSES"),
    extractConst("NON_SUCCESSFUL_SYNC_STATUSES"),
    extractFunction("sftpUploadRecordSucceeded"),
    extractFunction("sftpFingerprintMatches"),
    extractFunction("successfulSyncStatus"),
    "this.api = { sftpUploadRecordSucceeded, successfulSyncStatus };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

test("backend SFTP upload status classifiers reuse fixed sets", () => {
  const api = loadStatusHelpers();
  for (const status of ["failed", "error", "cancelled", "stalled"]) {
    assert.equal(api.sftpUploadRecordSucceeded({ ok: true, status }, ""), false, status);
  }
  for (const status of ["completed", "success", "succeeded", "done"]) {
    assert.equal(api.sftpUploadRecordSucceeded({ status }, ""), true, status);
  }
  assert.equal(api.sftpUploadRecordSucceeded({ ok: true, fingerprint: "current" }, "current"), true);
  assert.equal(api.sftpUploadRecordSucceeded({ ok: true, fingerprint: "stale" }, "current"), false);
  assert.equal(api.sftpUploadRecordSucceeded({ results: [{ status: "done" }, { status: "failed" }] }, ""), false);
});

test("backend sync success classifier preserves exact and substring exclusions", () => {
  const api = loadStatusHelpers();
  for (const value of ["", "-", "待同步", "pending", "unknown", "running", "已跳过", "未参与本次同步", "failed: denied", "sync error", "未参与 Hub", "skipped"]) {
    assert.equal(api.successfulSyncStatus(value), false, value);
  }
  for (const value of ["已同步", "已同步 2 台", "success", "future-success-state"]) {
    assert.equal(api.successfulSyncStatus(value), true, value);
  }
});

test("backend SFTP and sync classifiers keep fixed-set wiring", () => {
  for (const name of ["SFTP_UPLOAD_FAILURE_STATUSES", "SFTP_UPLOAD_SUCCESS_STATUSES", "NON_SUCCESSFUL_SYNC_STATUSES"]) {
    assert.match(extension, new RegExp(`const ${name} = new Set\\(`));
  }
  assert.doesNotMatch(extractFunction("sftpUploadRecordSucceeded"), /\[[^\]]+\]\.includes\(status\)/);
  assert.doesNotMatch(extractFunction("successfulSyncStatus"), /\[[^\]]+\]\.includes\(text\)/);
});
