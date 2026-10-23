const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("drawer UI keeps closed-loop helpers and inspector hub facts", () => {
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.match(panel, /function renderResultEvidenceWorkbench\(/);
  assert.match(panel, /var\(--tree-col\)/);
  assert.match(panel, /resourceTree:hover|always-visible three columns|\.resourceTree \{/);
  assert.match(panel, /function renderWorkbenchInspector\(state, options\)/);
});

test("explicit result refresh uses current Worker collection without stale dirty narrowing", async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../dist/extension/legacy.js'), 'utf8');
  const method = require('../_helpers/legacyMethod')(source, 'refreshResultsSummary(');
  const calls = [], updates = [];
  const refresh = new Function('ResultCollectionHost_1', 'errorMessage', 'return ({' + method + '}).refreshResultsSummary;')(
    {resultCollectionHost: owner => ({update: async (...args) => {updates.push({owner,args});}})}, error => error.message);
  const owner = {effectiveConnectionMode: () => 'worker_pool', postState: () => calls.push('post'),
    recordActionError: error => assert.fail(error.message), lastError: 'previous',
    shouldRefreshResultsSummaryForDirtyPlan: () => assert.fail('dirty cache cannot narrow actual collection')};
  await refresh.call(owner, 'experiments/plans/a.yaml');
  assert.equal(updates.length, 1); assert.equal(updates[0].owner, owner);
  assert.deepEqual(updates[0].args, []); assert.equal(owner.lastError, undefined);
  assert.deepEqual(calls, ['post']);
  owner.effectiveConnectionMode = () => 'offline_import'; owner.offlineBundle = {id:'explicit-offline'};
  owner.applyOfflineResultsSummaryFromBundle = bundle => assert.equal(bundle, owner.offlineBundle);
  await refresh.call(owner); assert.equal(updates.length, 1); assert.equal(calls.length, 2);
});
