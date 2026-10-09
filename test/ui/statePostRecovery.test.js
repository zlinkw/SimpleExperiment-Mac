const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const flush = source.match(/private flushStatePost[\s\S]*?private scheduleStatePostRetry/)?.[0] || "";
const retry = source.match(/private scheduleStatePostRetry[\s\S]*?private integration/)?.[0] || "";

test("failed webview state posts retain pending state and retry with a bound", () => {
  assert.match(source, /private statePostInFlight = false/);
  assert.match(source, /private readonly statePostRetryMax = 3/);
  assert.match(flush, /if \(this\.statePostInFlight\)[\s\S]{0,100}this\.statePostPending = true/);
  assert.ok(flush.indexOf("this.lastPostedStateSignature = signature") > flush.indexOf("if (!delivered)"));
  assert.match(flush, /if \(!delivered\)[\s\S]{0,120}reportPostError/);
  assert.match(flush, /this\.lastStatePostErrorSignature/);
  assert.match(flush, /this\.scheduleStatePostRetry\(\)/);
  assert.match(retry, /this\.statePostRetryCount >= this\.statePostRetryMax/);
  assert.match(retry, /this\.flushStatePost\(true\)/);
});
