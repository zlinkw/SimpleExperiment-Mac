const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyRemoteAssets, assertNewerPreview } = require("../../scripts/mac-release-common");
test("publishing requires exactly the fully uploaded matching size and SHA-256 asset set", () => {
  const expected = [{ name: "release.json", size: 100, sha256: "a".repeat(64) }, { name: "sftp.vsix", size: 200, sha256: "b".repeat(64) }, { name: "experiment.vsix", size: 300, sha256: "c".repeat(64) }];
  const actual = expected.map(item => ({ ...item, digest: "sha256:" + item.sha256, state: "uploaded" }));
  assert.doesNotThrow(() => verifyRemoteAssets(expected, actual));
  for (const broken of [actual.slice(1), [...actual, actual[0]], actual.map((item, i) => i ? item : { ...item, size: 101 }), actual.map((item, i) => i ? item : { ...item, digest: "sha256:bad" }), actual.map((item, i) => i ? item : { ...item, state: "starter" })]) assert.throws(() => verifyRemoteAssets(expected, broken));
});
test("release fixes must increase preview versions and never silently downgrade", () => {
  const releases = [{ tag_name: "preview-v0.5.264", draft: false }, { tag_name: "preview-v9.0.0", draft: true }];
  assert.doesNotThrow(() => assertNewerPreview("preview-v0.5.265", releases));
  assert.throws(() => assertNewerPreview("preview-v0.5.264", releases));
  assert.throws(() => assertNewerPreview("preview-v0.5.263", releases));
});
test("local release scripts never install VS Code extensions, trigger Actions or overwrite release assets", () => {
  for (const file of ["mac-release-prepare.js", "mac-release-publish.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../../scripts", file), "utf8");
    assert.doesNotMatch(source, /--install-extension|install:latest|--clobber|--force|workflow.*run|gh.*actions/);
  }
  const source = fs.readFileSync(path.join(__dirname, "../../scripts/mac-release-publish.js"), "utf8");
  assert.ok(source.indexOf("verifyRemoteAssets(expected, complete)") < source.indexOf('"draft=false"'));
  assert.match(source, /never overwrite/);
});

test("paired release gates include both repositories' POSIX path regressions", () => {
  const prepare = fs.readFileSync(path.join(__dirname, "../../scripts/mac-release-prepare.js"), "utf8");
  assert.equal((prepare.match(/"macPosixPaths"/g) || []).length, 2);
  assert.match(prepare, /"macRelativePaths"/);
  assert.match(prepare, /"macDownloadScope"/);
  assert.equal((prepare.match(/"macCliLauncher"/g) || []).length, 2);
  assert.equal((prepare.match(/"macCliApi"/g) || []).length, 2);
  assert.match(prepare, /"macCliWorkflow"/);
  assert.match(prepare, /"macWorkflowBinding"/);
  for (const file of ["macResultIdentity", "projectResultTables", "manualDistributedResultSync", "projectResultSyncCompleteness", "remoteResultInspectionWorkflow", "resultCsvDirectoryConfig", "datasetResultCatalog"]) assert.ok(prepare.includes('"' + file + '"'));
  for (const file of ["macPlanIdentity", "macPlanFiles", "macAgentPlanIdentity", "macPlanLaunchPaths", "distributedPlanExecutionMode", "planRunModeWorkflow", "distributedProjectContract", "distributedPlanQueue", "distributedJobAutoRetry", "planSafeRetry", "distributedPlanSubmissionRouting", "planSubmissionVisiblePreflight"]) assert.ok(prepare.includes('"' + file + '"'));
  assert.match(prepare, /"--test-timeout", "20000"/);
});
