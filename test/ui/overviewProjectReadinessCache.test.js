const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name) {
  const start = panelSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing const ${name}`);
  const end = panelSource.indexOf(";", start);
  assert.ok(end > start, `unterminated const ${name}`);
  return panelSource.slice(start, end + 1);
}

test("project readiness reuses one derivation per Webview state object", () => {
  let planLookups = 0;
  const sandbox = {
    overviewProjectReadinessCacheState: null,
    overviewProjectReadinessCacheValue: null,
    overviewProjectStats: () => ({ plans: 0 }),
    asArray: (value) => Array.isArray(value) ? value : [],
    planFromContext: () => { planLookups += 1; return null; },
    serverSetupReadiness: () => ({ ready: true }),
    executionWorkerReadiness: () => ({ ready: true }),
    projectEndpointReadiness: () => ({ ready: true }),
    projectOutputGateDiagnostics: () => ({ ok: true, missing: [] }),
    simpleSftpReadinessForState: () => ({ ready: true }),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("PLAN_WORKFLOW_TERMINAL_PHASES"),
    extractFunction("overviewProjectReadiness"),
    "this.readiness = overviewProjectReadiness;",
  ].join("\n"), sandbox);

  const firstState = { detectedProject: {}, plans: [] };
  const first = sandbox.readiness(firstState);
  assert.equal(sandbox.readiness(firstState), first);
  assert.equal(planLookups, 1);

  const second = sandbox.readiness({ detectedProject: {}, plans: [] });
  assert.notEqual(second, first);
  assert.equal(planLookups, 2);
  assert.equal(second.status, "待创建 Plan");
});

test("overview consumers share cached project readiness", () => {
  for (const name of ["compactOverviewProjectReadinessForSignature"]) {
    assert.match(extractFunction(name), /overviewProjectReadiness\(/, name);
  }
});
