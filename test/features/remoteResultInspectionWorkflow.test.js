const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agent = readSource("src/clusterAgentRuntime.ts");
const fileClient = readSource("src/tunnel/FileTransferClient.ts");
const realtimeClient = readSource("src/tunnel/RealtimeTunnelClient.ts");
const multiClient = readSource("src/tunnel/MultiEndpointRealtimeClient.ts");
const { isSafeRemotePath } = require("../../src/tunnel/FileTransferTypes.ts");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

function loadHelpers() {
  const start = extension.indexOf("const REMOTE_RESULT_INSPECTION_MAX_BYTES");
  const end = extension.indexOf("function findDebugBundlePath", start);
  assert.ok(start > 0 && end > start);
  const sandbox = {
    path,
    crypto,
    ProjectResultTables: require("../../dist/results/ProjectResultTables.js"),
    WrapperResultBundle: require("../../dist/results/WrapperResultBundle.js"),
    process: { platform: 'win32' },
    FileTransferTypes_1: { isSafeRemotePath },
    normalizePlanSelectionKey: (value) => String(value || "").trim().replace(/\\/g, "/"),
    operationResultPlanFile(item) {
      return String(item.planFile || item.plan_file || item.plan || item.selectedPlanId || (item.options || {}).planFile || "");
    },
    samePlanSelection(left, right) {
      const key = (value) => String(value || "").replace(/\\/g, "/").toLowerCase().replace(/^experiments\/plans\//, "");
      return Boolean(key(left) && key(left) === key(right));
    },
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    stringFromRecord(item, keys) {
      for (const key of keys) if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
      return "";
    },
    planVersionTimestamp(value) {
      const parsed = Date.parse(String(value || ""));
      return Number.isFinite(parsed) ? parsed : NaN;
    },
    safePlanToken: (value) => String(value || "experiment").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "experiment",
    normalizeResultCsvDir: (value) => String(value || "experiments/results").replace(/\\/g, "/"),
    DEFAULT_RESULT_CSV_DIR: "experiments/results",
    Date,
  };
  vm.createContext(sandbox);
  const helpers = ts.transpileModule(extension.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(helpers + "\nthis.api = { REMOTE_RESULT_INSPECTION_MAX_BYTES, normalizeRemoteResultInspectionPath, remoteResultInspectionLocalRelativePath, methodResultArtifactLocalRelativePath, remoteResultInspectionCandidates, resultSummaryInspectionCandidates, resultSummarySyncCandidates };", sandbox);
  return sandbox.api;
}

function loadPanelDetailHelper() {
  const start = panel.indexOf("function normalizeUnparseableDetails");
  const end = panel.indexOf("function operationSearchText", start);
  assert.ok(start > 0 && end > start);
  const sandbox = {
    asArray(value) {
      return Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(panel.slice(start, end) + "\nthis.api = { normalizeUnparseableDetails };", sandbox);
  return sandbox.api;
}

test("remote result inspection accepts only lightweight project files", () => {
  const helpers = loadHelpers();
  assert.equal(helpers.REMOTE_RESULT_INSPECTION_MAX_BYTES, 5 * 1024 * 1024);
  for (const file of [
    "metrics_summary.csv",
    "work_dirs/smoke/metrics_summary.csv",
    "outputs/eval/metrics.json",
    "reports/run/summary.txt",
    "logs/run/stdout.log",
    "artifacts/eval/output.out",
    "outputs/plot.png",
    "simple_cluster/results/by_plan/demo/final.md",
  ]) {
    assert.equal(helpers.normalizeRemoteResultInspectionPath(file), file);
  }
  for (const file of ["/etc/passwd", "../metrics.csv", "work_dirs/model.pt", "reports/id_rsa.txt", "logs/key.pem"]) {
    assert.equal(helpers.normalizeRemoteResultInspectionPath(file), "");
  }
  const local = helpers.remoteResultInspectionLocalRelativePath("work_dirs/smoke/metrics_summary.csv", "experiments/plans/smoke.yaml", "2026-07-17T12:34:56.000Z");
  assert.match(local, /^simple_cluster\/downloads\/result_inspection\/experiments_plans_smoke\.yaml\/metrics_summary__[a-f0-9]{10}__20260717123456\.csv$/);
});

test("result buttons sync to project results directory with stable Plan and Worker names", () => {
  const { methodResultArtifactLocalRelativePath: target } = loadHelpers();
  const plan = "experiments/plans/comparison/concatenation.yaml";
  const summary = {
    rawResultCsvPath: "experiments/results/concatenation.csv",
    aggregateCsvPath: "simple_cluster/results/by_plan/concatenation/seed_mean_std.csv",
    projectAggregateCsvPath: "simple_cluster/results/project_seed_mean_std.csv",
    finalCsvPath: "simple_cluster/results/by_plan/concatenation/final.csv",
    finalMarkdownPath: "simple_cluster/results/by_plan/concatenation/final.md",
    projectFinalCsvPath: "simple_cluster/results/project_final.csv",
    projectFinalMarkdownPath: "simple_cluster/results/project_final.md",
  };
  for (const [field, kind] of [["rawResultCsvPath", "raw"], ["aggregateCsvPath", "detail"], ["projectAggregateCsvPath", "detail"], ["finalCsvPath", "trace"], ["finalMarkdownPath", "trace"], ["projectFinalCsvPath", "trace"], ["projectFinalMarkdownPath", "trace"]]) {
    assert.match(target(summary[field], plan, summary), new RegExp("^experiments/results/_unassigned/plans/concatenation__[a-f0-9]{8}/" + kind + "/"));
  }
  assert.match(target(summary.aggregateCsvPath, plan, { workerResultTables: [{ workerId: "nwpu3", aggregateCsvPath: summary.aggregateCsvPath }] }, "artifacts/results", "nwpu3"), /^artifacts\/results\/_unassigned\/plans\/concatenation__[a-f0-9]{8}\/detail\/nwpu3__[a-f0-9]{8}\//);
  const source = dataset => ({...summary, results: [{dimensions: {dataset}, sourceFiles: [{path: summary.rawResultCsvPath}]}]});
  assert.notEqual(target(summary.rawResultCsvPath, plan, source("BUS")), target(summary.rawResultCsvPath, plan, source("PAD")));
  assert.notEqual(target(summary.rawResultCsvPath, plan, source("BUS")), target(summary.rawResultCsvPath, "experiments/plans/other/concatenation.yaml", source("BUS")));
  assert.match(target(summary.rawResultCsvPath, plan, {...summary, datasetResultTables: ["BUS", "PAD"].map(dataset => ({dataset, rawResultCsvPath: summary.rawResultCsvPath}))}), /^experiments\/results\/_shared\/plans\//);

});

test("bulk sync keeps current Plan scope and separates identical paths from different Workers", () => {
  const { resultSummarySyncCandidates } = loadHelpers();
  const plan = "experiments/plans/comparison/concatenation.yaml";
  const raw = "experiments/results/concatenation.csv";
  const aggregate = "simple_cluster/results/by_plan/concatenation/seed_mean_std.csv";
  const finalCsv = "simple_cluster/results/by_plan/concatenation/final.csv";
  const summary = {
    planFile: plan,
    rawResultCsvPath: raw,
    aggregateCsvPath: aggregate,
    finalCsvPath: finalCsv,
    workerResultTables: [
      { workerId: "nwpu3", rawResultCsvPath: raw, aggregateCsvPath: aggregate, finalCsvPath: finalCsv },
      { workerId: "nwpu5", rawResultCsvPath: raw, aggregateCsvPath: aggregate, finalCsvPath: finalCsv },
    ],
  };
  assert.deepEqual(Array.from(resultSummarySyncCandidates(summary, plan), (item) => ({ ...item })), [
    { remotePath: raw, workerId: "nwpu3", bytes: null, sha256: "" },
    { remotePath: raw, workerId: "nwpu5", bytes: null, sha256: "" },
    { remotePath: aggregate, workerId: "nwpu3", bytes: null, sha256: "" },
    { remotePath: aggregate, workerId: "nwpu5", bytes: null, sha256: "" },
    { remotePath: finalCsv, workerId: "nwpu3", bytes: null, sha256: "" },
    { remotePath: finalCsv, workerId: "nwpu5", bytes: null, sha256: "" },
  ]);
  assert.deepEqual(Array.from(resultSummarySyncCandidates(summary, "experiments/plans/comparison/other.yaml")), []);
});

test("remote result inspection is authorized by the matching Plan contract operation", () => {
  const helpers = loadHelpers();
  const operations = {
    matching: {
      type: "check-output-contract",
      planFile: "experiments/plans/smoke.yaml",
      updatedAt: "2026-07-17T10:00:00Z",
      contractReport: {
        unparseableFiles: ["work_dirs/smoke/metrics_summary.csv", "outputs/smoke/metrics.json", "outputs/smoke/plot.png"],
      },
    },
    otherPlan: {
      type: "check-output-contract",
      planFile: "experiments/plans/other.yaml",
      unparseableFiles: ["work_dirs/other/metrics_summary.csv"],
    },
    unrelated: {
      type: "parse-results",
      planFile: "experiments/plans/smoke.yaml",
      unparseableFiles: ["work_dirs/smoke/untrusted.csv"],
    },
  };
  assert.deepEqual(
    Array.from(helpers.remoteResultInspectionCandidates([operations], "experiments/plans/smoke.yaml")),
    ["work_dirs/smoke/metrics_summary.csv", "outputs/smoke/metrics.json", "outputs/smoke/plot.png"]
  );
  assert.deepEqual(Array.from(helpers.remoteResultInspectionCandidates([operations], "experiments/plans/missing.yaml")), []);
  operations.latestSuccess = {
    type: "check-output-contract",
    planFile: "experiments/plans/smoke.yaml",
    updatedAt: "2026-07-17T11:00:00Z",
    status: "completed",
    contractReport: { unparseableFiles: [] },
  };
  assert.deepEqual(Array.from(helpers.remoteResultInspectionCandidates([operations], "experiments/plans/smoke.yaml")), []);

  operations.latestSuccess.planRevision = "rev-old";
  operations.currentVersion = {
    type: "check-output-contract",
    planFile: "experiments/plans/smoke.yaml",
    planRevision: "rev-current",
    updatedAt: "2026-07-17T10:30:00Z",
    contractReport: { unparseableFiles: ["work_dirs/smoke/current.csv"] },
  };
  assert.deepEqual(
    Array.from(helpers.remoteResultInspectionCandidates([operations], "experiments/plans/smoke.yaml", "rev-current", "2026-07-17T09:00:00Z")),
    ["work_dirs/smoke/current.csv"]
  );
});

test("generated result artifacts are authorized only by the matching Plan summary", () => {
  const helpers = loadHelpers();
  const summary = {
    planFile: "experiments/plans/smoke.yaml",
    previewCsvPath: "simple_cluster/results/by_plan/smoke/results_preview_all.csv",
    effectiveResultsCsvPath: "simple_cluster/results/by_plan/smoke/results_effective_archived.csv",
    statisticsPath: "simple_cluster/results/by_plan/smoke/statistics.json",
    paperTableCsvPath: "simple_cluster/results/by_plan/smoke/paper_table.csv",
    claimEvidence: { path: "simple_cluster/results/by_plan/smoke/claim_evidence.json" },
    qualityGatePath: "../outside.json",
  };
  assert.deepEqual(Array.from(helpers.resultSummaryInspectionCandidates(summary, "experiments/plans/smoke.yaml")), [
    "simple_cluster/results/by_plan/smoke/results_preview_all.csv",
    "simple_cluster/results/by_plan/smoke/results_effective_archived.csv",
    "simple_cluster/results/by_plan/smoke/statistics.json",
    "simple_cluster/results/by_plan/smoke/paper_table.csv",
    "simple_cluster/results/by_plan/smoke/claim_evidence.json",
  ]);
  assert.deepEqual(Array.from(helpers.resultSummaryInspectionCandidates(summary, "experiments/plans/other.yaml")), []);
});

test("extension and workbench expose a confirmed download-and-open path", () => {
  assert.match(extension, /case "downloadRemoteResult":\s*await this\.downloadRemoteResultFromUi\(message\)/);
  const download = extension.match(/async downloadRemoteResultFromUi\(message\)[\s\S]*?async openResultArtifactFromUi/)?.[0] || "";
  assert.match(download, /const generation = this\.projectContextGeneration/);
  assert.match(download, /const client = this\.client/);
  assert.ok([...download.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\) \|\| client !== this\.client/g)].length >= 4);
  assert.ok(download.indexOf("sync.downloadMappedPaths") < download.indexOf("await this.openWorkspaceFileForProjectContext(localRelative"));
  assert.match(extension, /remoteResultInspectionCandidates\(\[this\.localOperations, this\.lastRealtimeState\?\.operations\], planFile, version\.revision, version\.updatedAt\)/);
  assert.match(extension, /showWarningMessage\(\[\s*"【远端结果查看确认】"[\s\S]*`远端来源：\$\{remotePath\}`[\s\S]*`本地副本：\$\{localPath\}`[\s\S]*\{ modal: true \}, "下载并打开"\)/);
  assert.match(extension, /maxFileBytes: REMOTE_RESULT_INSPECTION_MAX_BYTES/);
  assert.match(extension, /await this\.openWorkspaceFileForProjectContext\(localRelative, \{ generation, root \}, client\)/);
  assert.doesNotMatch(extension.slice(extension.indexOf("async downloadRemoteResultFromUi"), extension.indexOf("async openAuditTail")), /openWorkspaceFile\(remotePath\)/);
  assert.match(panel, /downloadRemoteResult: \[\]/);
  assert.match(panel, /data-command="downloadRemoteResult" data-remote-path=/);
  assert.match(panel, /outputContractUnparseableFileList: item\.unparseableFileList/);
  assert.match(panel, /renderRemoteResultInspectionActions\(row\.unparseableFileList, row\.planFile, 3, row\.unparseableDetails\)/);
  assert.match(panel, /class="operationFileReason"/);
  assert.match(panel, /compactText\(error, 120\)/);
  assert.match(panel, /outputContractUnparseableDetails: item\.unparseableDetails/);
});

test("preview and effective CSV buttons open result artifacts without changing Plan selection", () => {
  const handler = extension.slice(extension.indexOf("async openResultArtifactFromUi"), extension.indexOf("async openAuditTail"));
  assert.match(extension, /case "openResultArtifact":\s*await this\.openResultArtifactFromUi\(message\)/);
  assert.match(extension, /"downloadRemoteResult", "openResultArtifact", "syncAllResultArtifacts", "rebuildProjectResultTables", "syncPendingPlanArtifacts", "splitProjectResultTable", "openLocalResultTable", "editResultColumnMapping", "openAuditTail"/);
  assert.match(handler, /this\.filterResultsSummaryForPlan\(this\.resultsSummary, planFile\)/);
  assert.match(handler, /const projectContext = this\.captureProjectContext\(\)/);
  assert.match(handler, /const client = this\.client/);
  assert.ok([...handler.matchAll(/isCurrent\(\)/g)].length >= 6);
  assert.match(handler, /resultSummaryInspectionCandidates\(summary, planFile\)/);
  assert.match(handler, /"【结果文件位置确认】"/);
  assert.match(handler, /`远端来源：\$\{artifactPath\}`/);
  assert.match(handler, /`本机结果位置：\$\{localCopyPath\}`/);
  assert.match(handler, /methodResultArtifactLocalRelativePath\(artifactPath, planFile, summary, this\.resultCsvDirectory \|\| DEFAULT_RESULT_CSV_DIR/);
  assert.match(handler, /owned\.finalCsvPath, owned\.finalMarkdownPath/);
  assert.doesNotMatch(handler, /experiments\/simple_project\.yaml/);
  assert.match(handler, /maxFileBytes: RESULT_ARTIFACT_MAX_BYTES/);
  assert.match(handler, /await this\.openWorkspaceFileForProjectContext\(localRelative, projectContext, client\)/);
  const opener = extension.slice(extension.indexOf("async openWorkspaceFileForProjectContext"), extension.indexOf("async openWorkspaceFolderForContinuation"));
  assert.match(opener, /const editorUri = workspaceEditorUriForFile\(file\)/);
  assert.ok([...opener.matchAll(/isCurrent\(\)/g)].length >= 5);
  assert.ok(opener.indexOf("await vscode.workspace.openTextDocument(editorUri)") < opener.indexOf("await vscode.window.showTextDocument(doc"));
  assert.doesNotMatch(handler, /selectPlanFromUi|this\.selectedPlanId\s*=/);
  assert.match(panel, /resultFileButton\("打开完整预览", previewCsvPath, resultPlanFile\)/);
  assert.match(panel, /resultFileButton\("打开有效结果", effectiveResultsCsvPath, resultPlanFile\)/);
  assert.match(panel, /function resultFileButton\(label, file, planFile, workerId, help, showUnavailable\)/);
  assert.match(panel, /data-command="openResultArtifact" data-remote-path=/);
  const buttonHelper = panel.slice(panel.indexOf("function resultFileButton"), panel.indexOf("function renderResultNextAction"));
  assert.doesNotMatch(buttonHelper, /data-command="openPlan"/);
});

test("Plan concise table is the primary result entry with scoped explanations", () => {
  assert.match(panel, /按数据集组织结果/);
  assert.match(panel, /data-command="openLocalResultTable"/);
  assert.match(panel, /查看共享产物/);
  assert.doesNotMatch(panel, /resultFileButton\("查看简洁汇总 CSV"/);
  assert.match(panel, /更新当前 Plan 指标表/);
  assert.doesNotMatch(panel, /data-details-key="result-trace-files"/);
  assert.doesNotMatch(panel, /原始数据与详细追溯/);
  assert.match(panel, /data-details-key="result-split-tables"/);
  assert.match(panel, /尚无总表。点击“同步服务器结果并更新总表”/);
  assert.match(panel, /重建当前 Plan 汇总/);
});

test("current Plan metrics delegate to the scoped rebuild and mapped downloads keep one overwrite review", () => {
  const handler = extension.slice(extension.indexOf("async syncAllResultArtifactsFromUi"), extension.indexOf("async syncPendingResultMetricsFromUi"));
  const download = extension.slice(extension.indexOf("    collectMappedResultDownloadBatches("), extension.indexOf("async publishDownloadedResultMetrics"));
  assert.match(extension, /case "syncAllResultArtifacts":\s*return this\.withManualResultSync\(\(\) => this\.syncAllResultArtifactsFromUi\(message\)\)/);
  assert.match(panel, /data-command="syncAllResultArtifacts" data-plan-file=/);
  assert.match(handler, /rebuildProjectResultTablesFromUi\(\{ planFiles: \[planFile\]/);
  assert.match(download, /methodResultArtifactLocalRelativePath\(remotePath, planFile, summary/);
  assert.match(download, /if \(existingCount && !options\.missingOnly\) \{/);
  assert.match(download, /sync\.downloadMappedPaths/);
  assert.doesNotMatch(handler, /client\.downloadWorkerFile\(|client\.downloadFile\(/);
  assert.doesNotMatch(handler, /selectPlanFromUi|this\.selectedPlanId\s*=/);
});

test("operation details retain each parser error and add file-only fallbacks", () => {
  const helpers = loadPanelDetailHelper();
  const details = helpers.normalizeUnparseableDetails([
    { path: "work_dirs/a/metrics_summary.csv", error: "value 列不是数值" },
  ], ["work_dirs/a/metrics_summary.csv", "work_dirs/b/metrics_summary.csv"]);
  assert.deepEqual(Array.from(details, (item) => ({ ...item })), [
    { path: "work_dirs/a/metrics_summary.csv", error: "value 列不是数值" },
    { path: "work_dirs/b/metrics_summary.csv", error: "" },
  ]);
  assert.match(agent, /"unparseable": report\.get\("unparseable"\) or \[\]/);
});

test("file transfer enforces the inspection size cap before streaming", () => {
  assert.match(fileClient, /query\.set\("maxBytes", String\(Math\.trunc\(maxBytes\)\)\)/);
  assert.match(fileClient, /contentLength > maxBytes/);
  assert.match(realtimeClient, /downloadFile\(remotePath: string, localPath: string, options: DownloadOptions = \{\}\)/);
  assert.match(realtimeClient, /this\.files\.downloadFile\(remotePath, localPath, options\)/);
  assert.match(multiClient, /downloadFile\(remotePath: string, localPath: string, options: DownloadOptions = \{\}\)/);
  assert.match(multiClient, /hubClient\(\)\.downloadFile\(remotePath, localPath, options\)/);
  assert.match(agent, /if int\(max_bytes or 0\) > 0 and size > int\(max_bytes\):/);
  assert.match(agent, /status=413/);
  assert.match(agent, /params\.get\("maxBytes"\)/);
});

test("file transfer sends maxBytes to the Hub file API", async () => {
  const previousFetch = global.fetch;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response('{"error":"file exceeds requested maxBytes"}', { status: 413, headers: { "content-type": "application/json" } });
  };
  try {
    const budget = { run: async (_kind, work) => work() };
    const client = new FileTransferClient({ localHost: "127.0.0.1", localPort: 18765 }, budget);
    await assert.rejects(
      client.downloadFile("work_dirs/smoke/metrics_summary.csv", path.join(root, "simple_cluster", "tmp", "unused.csv"), { maxBytes: 12345 }),
      /HTTP 413/
    );
    assert.match(requestedUrl, /maxBytes=12345/);
  } finally {
    global.fetch = previousFetch;
  }
});

 test("dataset tables remain eligible metric downloads with Worker ownership", () => {
  const helpers = loadHelpers();
  const planFile = "experiments/plans/comparison/demo.yaml";
  const summary = {planFile, datasetResultTables: [{dataset: "BUS", aggregateCsvPath: "simple_cluster/results/by_plan/demo/datasets/BUS/seed_mean_std.csv"}], projectDatasetTables: [{dataset: "PAD", finalCsvPath: "simple_cluster/results/by_dataset/PAD/project_final.csv"}], paperDatasetTables: [{dataset: "BUS", paperTableCsvPath: "paper/tables/BUS/simple_results_table__demo.csv"}], workerResultTables: [{workerId: "w1", datasetResultTables: [{dataset: "BUS", aggregateCsvPath: "simple_cluster/results/by_plan/demo/datasets/BUS/seed_mean_std.csv"}], projectDatasetTables: [{dataset: "PAD", finalCsvPath: "simple_cluster/results/by_dataset/PAD/project_final.csv"}], paperDatasetTables: [{dataset: "BUS", paperTableCsvPath: "paper/tables/BUS/simple_results_table__demo.csv"}]}]};
  const inspection = helpers.resultSummaryInspectionCandidates(summary, planFile);
  const sync = helpers.resultSummarySyncCandidates(summary, planFile);
  assert.equal(inspection.length >= 3, true);
  assert.equal(sync.length >= 3, true);
  assert.equal(sync.every(row => row.workerId === "w1"), true);
 });
