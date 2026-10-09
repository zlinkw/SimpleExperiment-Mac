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

test("results summary refresh stays selected-plan scoped without dirty narrowing", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /if \(requestedPlan && !this\.shouldRefreshResultsSummaryForDirtyPlan\(requestedPlan\)\)/);
  assert.match(source, /const planFile = this\.resolveSelectedPlanFile\(requestedPlan \|\| this\.planFileInput \|\| this\.selectedPlanId \|\| ""\)/);
  assert.doesNotMatch(source, /const planFile = selectedPlan \|\| dirtyPlan/);
});
