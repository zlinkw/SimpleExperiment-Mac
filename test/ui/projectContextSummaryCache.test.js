const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("server destinations remain visible for Hub and Worker", () => {
  assert.match(panel, /function renderServerDestinationPreview\(agentState, scope\)/);
  assert.match(panel, /renderServerDestinationPreview\(hubAgent, "hub"\)/);
  assert.match(panel, /renderServerDestinationPreview\(workerAgent, scope\)/);
});

test("project onboarding reads current setup and worker readiness", () => {
  const start = panel.indexOf("function renderProjectOnboardingFlow(");
  const end = panel.indexOf("function ", start + 9);
  const source = panel.slice(start, end);
  assert.match(source, /simpleSftpReadinessForState\(state\)/);
  assert.match(source, /serverSetupReadiness\(state\)/);
  assert.match(source, /executionWorkerReadiness\(state\)/);
});

test("section dependencies refresh when project and server context changes", () => {
  const start = panel.indexOf("function sectionDependencyKey(");
  const end = panel.indexOf("function sectionLocalPreKey(", start);
  const source = panel.slice(start, end);
  assert.match(source, /section === "settings"[^\n]*data\.agentSessions/);
  assert.match(source, /section === "plans"[^\n]*data\.detectedProject/);
  assert.match(source, /section === "results"[^\n]*data\.resultsSummary/);
});