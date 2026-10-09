const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("plan workflow exposes validate dry-run and run through tunnel actions", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /validatePlan: "validate-plan"/);
  assert.match(source, /dryRunPlan: "dry-run-plan"/);
  assert.match(source, /runPlan: "run-plan"/);
  assert.match(source, /if \(PLAN_SUBMISSION_COMMANDS\??\.has\(command\)\)[\s\S]*runPlanPreflight\(body/);
  assert.match(source, /async runPlanPreflight\(body, label, authority = \{\}[\s\S]*?postPlanSchedulerAction\("validate-plan"[\s\S]*\.\.\.authority[\s\S]*postPlanSchedulerAction\("dry-run-plan"[\s\S]*\.\.\.authority/);
  const html = readSource("src/ui/PanelHtml.ts");
  assert.match(html, /planFileInput/);
  assert.match(html, /data-command="validatePlan"[^>]*>校验<\/button>/);
  assert.match(html, /data-command="dryRunPlan"[^>]*>预演<\/button>/);
  assert.match(html, /data-command="runPlan"[^>]*>校验并提交运行<\/button>/);
  assert.match(html, /function planPhaseCommand\(command\)/);
  assert.match(html, /已等待 /);
  assert.match(html, /clearInterval\(timer\)/);
});

test("rendered plan phase script keeps validate and run pending past 45 seconds", () => {
  const html = require("../../dist/ui/PanelHtml.legacy.js").renderPanelHtml();
  const scriptStart = html.indexOf("<script nonce=");
  assert.ok(scriptStart > 0);
  const script = html.slice(scriptStart);
  const fnStart = script.indexOf("function planPhaseCommand");
  const fnEnd = script.indexOf("function renderCommandPhaseLine");
  const clearStart = script.indexOf("function clearPendingActionTimeout");
  const clearEnd = script.indexOf("function clearButtonsForPending");
  assert.ok(fnStart > 0 && fnEnd > fnStart && clearStart > 0 && clearEnd > clearStart);
  const sandbox = { pendingActionTimeouts: { click: 41 }, cleared: false };
  vm.runInNewContext(`${script.slice(fnStart, fnEnd)}\n${script.slice(clearStart, clearEnd)}
    this.limits = { validate: planPhaseCommand("validatePlan"), dry: planPhaseCommand("dryRunPlan"), run: planPhaseCommand("runPlan"), other: planPhaseCommand("status") };
    this.waited = formatWaited(46000);
    clearPendingActionTimeout("click");
  `, Object.assign(sandbox, { clearInterval() { sandbox.cleared = true; }, clearTimeout() {} }));
  assert.equal(sandbox.limits.validate, true);
  assert.equal(sandbox.limits.dry, true);
  assert.equal(sandbox.limits.run, true);
  assert.equal(sandbox.limits.other, false);
  assert.match(sandbox.waited, /46 秒/);
  assert.equal(sandbox.cleared, true);
  assert.equal(sandbox.pendingActionTimeouts.click, undefined);
  assert.match(script, /已等待 /);
  assert.doesNotMatch(script.slice(fnStart, fnEnd), /\\s|\\d/);
});
