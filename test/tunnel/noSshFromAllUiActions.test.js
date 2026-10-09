const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("all new ui actions use the current transport boundaries", () => {
  const extension = readSource("src/extension.ts");
  const panel = readSource("src/ui/PanelHtml.ts");
  const commands = [
    "validatePlan", "dryRunPlan", "runPlan", "stopExperiment", "retryExperiment", "reproducePlan",
    "parseResults", "refreshResults", "runQualityGate", "runStatistics", "exportPaperTable",
    "archiveArtifacts", "syncArtifacts", "completeThreeWay", "deleteArtifacts", "reconcileDeletions",
    "selfCheck", "createDebugBundle", "downloadDebugBundle", "openAuditTail", "downloadRemoteResult"
  ];
  for (const command of commands) assert.match(extension + panel, new RegExp(command), command);
  assert.match(extension, /postTunnelAction\(action, body/);
  assert.match(extension, /executeCommand\("simpleSftp\.uploadWorkspace"/);
  assert.match(extension, /executeCommand\("simpleSftp\.uploadFiles"/);
  assert.doesNotMatch(extension, /\b(?:runSsh|execFile|spawn)\s*\(/i);
  assert.doesNotMatch(panel, /\b(?:runSsh|execFile|spawn)\s*\(/i);
});
