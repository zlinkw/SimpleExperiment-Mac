const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

test("archived plan restore creates an isolated version with isolated configs and result scope", () => {
  assert.match(extension, /case "restoreArchivedPlan":/);
  assert.match(extension, /async restoreArchivedPlanFromUi\(message\)/);
  assert.match(extension, /path\.basename\(source\)\.toLowerCase\(\) !== "plan\.yaml"/);
  assert.match(extension, /readPlanArchiveBundle\(source\)/);
  assert.match(extension, /nextAvailableVersionedPlanFile\(path\.join\(planRoot, "_restored", path\.dirname\(originalRelative\)\), parsed\.name, parsed\.ext\)/);
  assert.match(extension, /safeArchiveBundleChildPath\(path\.join\(bundleDir, "configs"\), relative\)/);
  assert.match(extension, /path\.posix\.join\("experiments", "restored_assets", safePlanToken\(restoredFile\), "configs", relative\)/);
  assert.match(extension, /resultScopeFile: restoredFile/);
  assert.match(extension, /restorePlanText\(planText, \{ originalPlanFile, archivedPlanFile: file, restoredFile, planVersion, configPathMap, restoredEnvironmentDir, restoredParameterDir \}\)/);
  assert.match(extension, /const projectContext = this\.captureProjectContext\(\)/);
  assert.match(extension, /工作区已切换，归档 Plan 恢复已取消/);
  assert.match(extension, /await this\.persistProjectPlanSelectionState\(\)/);
  assert.match(extension, /自动切换到 Plan 工作台/);
});
