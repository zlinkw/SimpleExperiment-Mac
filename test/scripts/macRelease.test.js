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

test("reused release gates bind exact inputs, complete single-file commands, native routes and real zero-skip summaries", () => {
  const crypto = require('node:crypto');
  const { verifyValidationRecords, testCounts } = require('../../scripts/mac-release-validation');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const digest = 'a'.repeat(64), commits = ['sf-commit', 'exp-commit'];
  const expected = [{ component: 'experiment', file: 'test/features/macPanelTheme.test.js' }, { component: 'sftp', file: 'test/installPolicy.test.js' }];
  const summary = 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n';
  function fixture(change = () => {}) {
    const receipts = expected.map(row => ({ ...row, inputDigest: digest, platform: row.component === 'sftp' ? 'win32' : 'linux',
      exitCode: 0, timedOut: false, stdout: summary, argv: ['--test', '--test-force-exit', '--test-timeout', '20000', row.file] }));
    change(receipts);
    const bytes = receipts.map(row => Buffer.from(JSON.stringify(row)));
    const proof = { protocolVersion: 1, inputDigest: digest, commits, gates: expected.map((row, index) => ({ ...row, evidence: 'receipts/' + index + '.json', evidenceSha256: hash(bytes[index]) })) };
    return { proof, read: name => bytes[Number(name.split('/')[1].split('.')[0])] };
  }
  const good = fixture();
  assert.equal(verifyValidationRecords(good.proof, expected, digest, commits, good.read).size, 2);
  for (const change of [rows => rows[0].exitCode = 1, rows => rows[0].timedOut = true, rows => rows[0].inputDigest = 'old',
    rows => rows[0].argv[3] = '30000', rows => rows[1].platform = 'linux',
    rows => rows[0].stdout = summary.replace('skipped 0', 'skipped 1'), rows => rows[0].stdout = summary.replace('fail 0', 'fail 1'),
    rows => rows[0].stdout = summary.replace('cancelled 0', 'cancelled 1'), rows => rows[0].stdout += summary]) {
    const bad = fixture(change); assert.throws(() => verifyValidationRecords(bad.proof, expected, digest, commits, bad.read));
  }
  for (const proof of [{ ...good.proof, inputDigest: 'old' }, { ...good.proof, commits: ['other', 'exp-commit'] },
    { ...good.proof, gates: good.proof.gates.slice(1) }, { ...good.proof, gates: [good.proof.gates[0], good.proof.gates[0]] }])
    assert.throws(() => verifyValidationRecords(proof, expected, digest, commits, good.read));
  assert.throws(() => verifyValidationRecords(good.proof, expected, digest, commits, () => Buffer.from('changed')), /bytes changed/);
  assert.throws(() => testCounts(summary.replace('todo 0', 'todo 1')));
});

test("release input binding includes untracked candidate files and every compiled byte without retaining timestamps", () => {
  const { captureValidationInputs } = require('../../scripts/mac-release-validation');
  const { spawnSync } = require('node:child_process');
  const directory = require('../_helpers/retainedFixture')(path.resolve(__dirname, '../..'), 'validation-binding');
  const roots = Object.fromEntries(['experiment', 'sftp'].map(component => {
    const root = path.join(directory, component); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'entry.js'), 'compiled'); fs.writeFileSync(path.join(root, 'candidate.js'), 'source');
    const r = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 8000 }); assert.equal(r.status, 0, r.stderr);
    return [component, root];
  }));
  const first = captureValidationInputs(roots);
  assert.equal(first.records.length, 4); assert.equal(captureValidationInputs(roots).digest, first.digest);
  fs.writeFileSync(path.join(roots.experiment, 'dist', 'entry.js'), 'modified');
  assert.notEqual(captureValidationInputs(roots).digest, first.digest);
  fs.writeFileSync(path.join(roots.sftp, 'added.js'), 'new'); assert.equal(captureValidationInputs(roots).records.length, 5);
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
  assert.match(prepare, /"macTransferExitProof"/);
  assert.match(prepare, /"test\/features\/macAgentOutputContract\.test\.js"/);
  assert.match(prepare, /"test\/features\/macAgentResultFiles\.test\.js"/);
  assert.match(prepare, /"test\/features\/macAgentParseResults\.test\.js"/);
  assert.match(prepare, /"test\/features\/macArchiveEvidenceRead\.test\.js"/);
  assert.match(prepare, /"test\/features\/macProjectAggregateRead\.test\.js"/);
  assert.match(prepare, /"test\/features\/macClaimEvidenceRead\.test\.js"/);
  assert.match(prepare, /"test\/features\/macPlanAnalysisRead\.test\.js"/);
  assert.match(prepare, /"test\/features\/macCaseAnalysisRead\.test\.js"/);
  assert.match(prepare, /"test\/scripts\/macPackageProjection\.test\.js"/);
  assert.equal((prepare.match(/"macCliLauncher"/g) || []).length, 2);
  assert.equal((prepare.match(/"macCliApi"/g) || []).length, 2);
  assert.match(prepare, /"macCliWorkflow"/);
  assert.match(prepare, /"macWorkflowBinding"/);
  for (const file of ["macResultSummaryScope", "macMappedResultIdentity", "macResultFiles", "macLocalMetricParsing", "macResultOperationScope", "wrapperResultPersistence", "pendingResultMetricSync", "metricsDownloadEndToEnd", "resultsSummaryWebviewCache"]) assert.ok(prepare.includes('"' + file + '"'));
  for (const file of ["macPlanResultCandidates", "jsonConfigOnboarding", "macResultCandidates", "projectResultLocationClarity", "backendOutputDerivationCaches", "outputCandidateDedupRegression", "planScopedResultCandidateCache", "planSelectionPreviewAndWorkerEmptyState", "planOutputEvidenceSignals"]) assert.ok(prepare.includes('"' + file + '"'));
  for (const file of ["macResultIdentity", "projectResultTables", "manualDistributedResultSync", "projectResultSyncCompleteness", "remoteResultInspectionWorkflow", "resultCsvDirectoryConfig", "datasetResultCatalog"]) assert.ok(prepare.includes('"' + file + '"'));
  for (const file of ["macPlanIdentity", "macPlanFiles", "macAgentPlanIdentity", "macPlanLaunchPaths", "distributedPlanExecutionMode", "planRunModeWorkflow", "distributedProjectContract", "distributedPlanQueue", "distributedJobAutoRetry", "planSafeRetry", "distributedPlanSubmissionRouting", "planSubmissionVisiblePreflight"]) assert.ok(prepare.includes('"' + file + '"'));
  assert.match(prepare, /"--test-timeout", "20000"/);
});

test("release inventory uses the executing gate list and avoids rerunning the build's panel test", () => {
  const { getReleaseValidationInventory, runValidationTests } = require('../../scripts/mac-release-prepare');
  const inventory = getReleaseValidationInventory();
  const paths = inventory.map(item => item.file);
  assert.equal(new Set(paths).size, paths.length);
  for (const file of paths) assert.ok(fs.statSync(file).isFile(), file);
  assert.ok(paths.includes(path.resolve(__dirname, '../agent/durablePlanQueue.test.js')));
  for (const file of ['macResultPlanDirectoryKey', 'serverQueueLifecycle.integration', 'metricAliasRebuildWorkflow', 'syncResolution'])
    assert.ok(paths.includes(path.resolve(__dirname, '../features/' + file + '.test.js')), file);
  for (const item of inventory) {
    assert.equal(item.timeout, 20000);
    assert.deepEqual(item.args.slice(0, 4), ['--test', '--test-force-exit', '--test-timeout', '20000']);
  }
  const panel = path.resolve(__dirname, '../features/panelWebviewScriptHealth.test.js');
  const executed = [];
  runValidationTests((_command, args, cwd) => executed.push(path.resolve(cwd, args.at(-1))),
    { experiment: path.resolve(__dirname, '../..'), sftp: path.resolve(__dirname, '../../../SimpleSFTP-Mac') },
    process.execPath, new Set([panel]));
  assert.deepEqual([panel, ...executed].sort(), [...paths].sort());
});

// 079r review item: an unescaped backtick inside the notes template silently ends
// the template and turns the rest into template-subtraction expressions that only
// fail at runtime. The notes must be a pure-VM string produced by a call, never a
// BinaryExpression, and the generated text must be current, honest evidence.
test("release notes are a real string template built in pure VM use with no raw backticks", () => {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../../scripts/mac-release-prepare.js"), "utf8");
  const file = ts.createSourceFile("mac-release-prepare.js", source, ts.ScriptTarget.ES2022, true);
  let notesInit = null;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "notes") notesInit = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(notesInit, "notes declaration must exist");
  assert.equal(notesInit.kind, ts.SyntaxKind.CallExpression, "notes must be initialized by a call, never by template arithmetic");
  const call = notesInit;
  assert.ok(ts.isIdentifier(call.expression) && call.expression.text === "buildReleaseNotes", "notes must come from the pure buildReleaseNotes");
  assert.equal(call.arguments.length, 2);
  // A raw backtick silently closes a template and turns the rest into template
  // subtraction: BinaryExpression(MinusToken) with a template operand. Concatenation
  // with + is legitimate; subtraction of a template is never intended prose.
  const isTemplate = node => node.kind === ts.SyntaxKind.TemplateExpression || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
  const visit2 = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken && (isTemplate(node.left) || isTemplate(node.right)))
      throw new Error("template subtraction expression found");
    if (ts.isTaggedTemplateExpression(node)) throw new Error("tagged template found around release text");
    ts.forEachChild(node, visit2);
  };
  visit2(file);
  // 纯VM、无网络生成回归：只调用导出函数，不触碰 main/fs/网络。
  const { buildReleaseNotes } = require("../../scripts/mac-release-prepare.js");
  const notes = buildReleaseNotes(["aaaa1111", "bbbb2222"], ["0.2.102", "0.5.315"]);
  assert.equal(typeof notes, "string");
  assert.ok(notes.includes("SimpleSFTP Mac 0.2.102") && notes.includes("SimpleExperiment Mac 0.5.315"), "versions come from the call, not hardcoded prose");
  assert.ok(notes.includes("SimpleSFTP-Mac aaaa1111") && notes.includes("SimpleExperiment-Mac bbbb2222"));
  assert.equal(notes.includes("`"), false, "generated notes carry no stray backticks");
  assert.match(notes, /未在M5真机执行/);
  assert.match(notes, /不宣称任何真机通过/);
  assert.match(notes, /历史计数，不表示本版本验收完成/);
  assert.doesNotMatch(notes, /234\/28/);
  assert.doesNotMatch(notes, /WSL tmux\/Git Bash\/std库环境探针/);
  assert.doesNotMatch(notes, /已证明部分最小启动/);
  // 终验脏树门禁必须在写 notes 之后、成功输出之前。
  assert.ok(source.indexOf("status\", \"--porcelain\"") > source.indexOf("release-notes.md\""));
});


test("release keeps every new GPU, root-map and isolated-retry safety domain", () => {
  const rows = require('../../scripts/mac-release-prepare').getReleaseValidationInventory();
  const files = new Set(rows.map(row => row.file.replaceAll('\\', '/')));
  for (const relative of ['agent/gpuCollectorFrame', 'agent/gpuCollectorRealTmux',
    'features/projectRootMap', 'features/planIsolatedReview', 'features/planIsolatedBatchLedger',
    'features/planJobDeleteRequeueProduction', 'scripts/macRuntimeTemplate'])
    assert.ok(files.has(path.resolve(__dirname, '../' + relative + '.test.js').replaceAll('\\', '/')), relative);
});
