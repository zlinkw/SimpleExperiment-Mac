const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("settings is a secondary main-column view without changing side drawers", () => {
  assert.match(panel, /body:not\(\.main-view-settings\) #mainColumn > \[data-section="settings"\] \{ display: none; \}/);
  assert.match(panel, /body\.main-view-settings #mainColumn > \[data-section\]:not\(\[data-section="settings"\]\) \{ display: none; \}/);
  assert.match(panel, /class="cardTools">\s*<button[^>]*data-main-view="workspace"[^>]*title="关闭设置，返回主界面"[^>]*>关闭设置<\/button>/);
  assert.doesNotMatch(panel, /settingsBackButton[^>]*>&#8592;<\/button>/);
  assert.match(panel, /function applyMainViewForSection\(section\)/);
  assert.match(panel, /function switchMainView\(view\)/);
  assert.match(panel, /lastWorkspaceResource = \{ section: activeResourceSection/);
  assert.match(panel, /applyMainViewForSection\(nextSection\);\s*expandResourceSection\(nextSection\);/);
});

function productionFunction(name) {
  const start = panel.indexOf(`    function ${name}(`);
  const end = panel.indexOf("\n    function ", start + 10);
  assert.ok(start >= 0 && end > start);
  return panel.slice(start, end);
}

function settingsFixture(drafts = {}) {
  const nodes = Object.fromEntries(["serverSettingsCards", "remoteRootPolicySettings", "pluginUpdateSettings", "resultCsvDirectorySettings", "resultColumnMappingSettings", "projectAdapterRuleSettings", "syncChainOverview"].map(id => [id, { innerHTML: "", contains: input => input?.containerId === id }]));
  const samples = [];
  const errors = [];
  const sandbox = {
    configDrafts: drafts, serverConfigEditLockUntil: 0, document: { activeElement: null }, el: id => nodes[id],
    panelNow: () => 0, sectionIsCollapsed: () => false, panelSectionShouldRenderNow: () => true,
    panelSectionPayloadNotLoaded: () => false, clearPanelSectionLoadingStatus() {}, sectionPreRenderKey: state => state.sectionRevisions.settings,
    sectionRenderModel: state => state.setup, sectionRenderSignature: state => JSON.stringify(state),
    dirtyPanelSections: new Set(), failedPanelSections: new Set(), lastSectionPreRenderKeys: {}, lastRenderedSectionSignatures: {},
    recordPanelSectionSample: (...args) => samples.push(args), applyResourceTreeChildLayout() {},
    renderSectionFailure: (_, error) => errors.push(error.message), vscode: { postMessage: message => errors.push(message.error) }, panelDocumentGeneration: 1,
    setHtmlIfChanged: (id, html) => { nodes[id].innerHTML = html; },
    esc: value => String(value ?? ""), escAttr: value => String(value ?? ""), asArray: value => Array.isArray(value) ? value : [],
    serverStatusIndexesForState: () => ({ workerStatus: new Map(), assignmentById: new Map(), conflictById: new Map(), agentWorkerById: new Map() }),
    sessionForPath: () => null, taskDetailLine: () => "", configDefault: (value, fallback) => value ?? fallback,
    configHelp: () => "", helpBadge: () => "", configInputBounds: () => null, configBoundsHint: () => "", configBoundsViolation: () => "", configCondaEnvViolation: () => "", configBoundsAttrs: () => "", displayValue: value => value,
    configSessionSelect: () => "", configPortPair: () => "", tunnelHost: value => value, formatTunnelAddress: () => "", sessionStatusCell: () => "",
    treeAnchorId: (prefix, id) => prefix + id, topologyModeLabel: value => value,
    renderProjectRuleEditor: () => '<input data-config-input="projectAdapterRules" data-key="primaryMetric">',
  };
  for (const name of ["renderSchedulerGlossary", "renderServerDestinationPreview", "renderSchedulerDependencyStatus", "renderTensorBoardLinkRow", "renderXshellSessionBudgetNote", "renderServerChainOverview"]) sandbox[name] = () => "";
  const names = ["navigateToResourceTarget", "renderSectionIfVisible", "renderServerSettings", "renderServerCardsV2", "renderPluginUpdateSettings", "pluginUpdateStatusLabel", "renderRemoteRootPolicySettings", "remoteRootPolicyText", "remoteRootPolicyCount", "renderResultCsvDirectorySettings", "renderResultColumnMappingSettings", "configInput", "configSelect", "activeConfigScope", "configScopeHasDraft", "shouldKeepConfigDraftScope", "isServerConfigScope", "shouldKeepServerConfigDraft", "configDraftValue"];
  if (panel.includes("function configContainerHasEditor(")) names.push("configContainerHasEditor");
  Object.assign(sandbox, { activeResourceSection: "plans", activeResourceAnchor: "plans", applyMainViewForSection() {}, expandResourceSection() {}, syncPanelSectionInterest() {}, updateResourceTreeActiveSection() {}, resolveResourceScrollTarget: () => null, detailsOpenState: {}, scrollToResourceTarget() {}, forceWorkbenchInspectorRender() {}, renderWorkbenchInspector() {} });
  vm.createContext(sandbox);
  vm.runInContext(names.map(productionFunction).join("\n"), sandbox);
  const state = { sectionRevisions: { settings: 1 }, setup: { workerTunnels: [{ id: "worker-a", workerHost: "worker.example", workerUser: "alice", agentProjectDir: "/srv/projects" }] }, topology: { mode: "worker_pool", workerCount: 1 }, resultOutputConfig: { csvDirectory: "experiments/results" } };
  return { nodes, errors, samples, sandbox, state, render(next = state) { sandbox.lastState = next; vm.runInContext("navigateToResourceTarget('settings', 'settings');", sandbox); } };
}

test("real settings render mounts all dynamic containers despite restored server and result drafts", () => {
  const f = settingsFixture({ "worker:worker-a": { workerUser: "draft-user" }, remotePolicy: { allowedRoots: "/srv/draft" }, resultOutput: { csvDirectory: "draft/results" } });
  f.render();
  assert.deepEqual(f.errors, []);
  for (const id of ["serverSettingsCards", "remoteRootPolicySettings", "pluginUpdateSettings", "resultCsvDirectorySettings", "resultColumnMappingSettings", "projectAdapterRuleSettings"]) assert.ok(f.nodes[id].innerHTML.length > 0, id);
  assert.match(f.nodes.serverSettingsCards.innerHTML, /worker\.example/);
  assert.match(f.nodes.serverSettingsCards.innerHTML, /draft-user/);
  assert.match(f.nodes.remoteRootPolicySettings.innerHTML, /\/srv\/draft/);
  assert.match(f.nodes.resultCsvDirectorySettings.innerHTML, /draft\/results/);
});

test("focused settings input keeps its mounted editor while unrelated containers still hydrate", () => {
  const f = settingsFixture({ "worker:worker-a": { workerUser: "typing-user" } });
  f.nodes.serverSettingsCards.innerHTML = '<input value="typing-user">';
  f.sandbox.document.activeElement = { containerId: "serverSettingsCards", dataset: { configInput: "worker:worker-a" } };
  f.render();
  assert.deepEqual(f.errors, []);
  assert.equal(f.nodes.serverSettingsCards.innerHTML, '<input value="typing-user">');
  assert.ok(f.nodes.pluginUpdateSettings.innerHTML.length > 0);
  assert.ok(f.nodes.resultCsvDirectorySettings.innerHTML.length > 0);
  f.sandbox.document.activeElement = null;
  f.render({ ...f.state, sectionRevisions: { settings: 2 }, setup: { workerTunnels: [{ ...f.state.setup.workerTunnels[0], workerHost: "updated.example" }] } });
  assert.match(f.nodes.serverSettingsCards.innerHTML, /updated\.example/);
  assert.match(f.nodes.serverSettingsCards.innerHTML, /typing-user/);
});

test("settings navigation immediately renders server configuration even when the card was already expanded", () => {
  const renders = [];
  const calls = [];
  const sandbox = {
    activeResourceSection: "plans", activeResourceAnchor: "plans", lastState: { setup: { workerTunnels: [{ id: "worker-a" }] } },
    applyMainViewForSection: section => calls.push(["view", section]),
    expandResourceSection: section => calls.push(["expand", section]),
    syncPanelSectionInterest: () => calls.push(["interest"]),
    renderSectionIfVisible: (state, section, options) => renders.push({ state, section, options }),
    updateResourceTreeActiveSection() {}, resolveResourceScrollTarget: () => null, detailsOpenState: {},
    scrollToResourceTarget() {}, forceWorkbenchInspectorRender() {}, renderWorkbenchInspector() {},
  };
  vm.runInNewContext(`${productionFunction("navigateToResourceTarget")}\nnavigateToResourceTarget('settings', 'settings');`, sandbox);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].section, "settings");
  assert.equal(renders[0].options.force, true);
  assert.equal(renders[0].state.setup.workerTunnels[0].id, "worker-a");
  assert.equal(sandbox.activeResourceSection, "settings");
  assert.ok(calls.some(row => row[0] === "interest"));
});

test("card decoration preserves the settings close button across full-state and layout refreshes", () => {
  const tools = { dataset: {}, innerHTML: "" };
  const card = { dataset: { section: "settings" }, classList: { contains: () => false }, querySelector: () => ({ querySelector: () => tools }) };
  const sandbox = { document: { querySelectorAll: () => [card] }, layoutEdit: false, escAttr: value => value };
  vm.runInNewContext(`${productionFunction("decorateCards")}\ndecorateCards();`, sandbox);
  assert.match(tools.innerHTML, /data-main-view="workspace"[^>]*>关闭设置/);
  assert.doesNotMatch(tools.innerHTML, /data-collapse-section/);
  tools.dataset.cardToolsSig = "";
  vm.runInNewContext("decorateCards();", sandbox);
  assert.match(tools.innerHTML, /关闭设置/);
});

test("resource tree omits settings even if saved layout order contains it", () => {
  const source = productionFunction("renderResourceTree");
  const sidebar = { innerHTML: "" };
  const sandbox = {
    currentUiLayout: { order: ["plans", "settings", "results"] }, normalizeUiLayout: value => value,
    resourceTreeNextRenderKey: value => value.join("|"), resourceTreeNeedsRerender: () => true,
    resourceTreeStaticModelCached: () => ({ plans: { label: "Plans", node: { section: "plans" } }, settings: { label: "Settings", node: { section: "settings" } }, results: { label: "Results", node: { section: "results" } } }),
    normalizeTreeTone: value => value, registerResourceTreeNodes() {}, updateResourceTreeHead() {}, resourceTreeFilter: "",
    el: id => id === "resourceTreeBody" ? sidebar : null, setHtmlIfChanged: (node, html) => { node.innerHTML = html; },
    renderResourceTreeNode: node => node.section, escAttr: value => value, updateResourceTreeActiveSection() {}, renderResourceTreeInspector() {},
    activeResourceSection: "plans", activeResourceAnchor: "plans",
  };
  vm.runInNewContext(`${source}\nrenderResourceTree({});`, sandbox);
  assert.match(sidebar.innerHTML, /plans/);
  assert.match(sidebar.innerHTML, /results/);
  assert.doesNotMatch(sidebar.innerHTML, /settings/);
});

test("settings secondary view keeps pin and three-column mechanisms intact", () => {
  assert.match(panel, /data-drawer-pin="tree"/);
  assert.match(panel, /data-drawer-pin="inspector"/);
  assert.match(panel, /body\.tree-pinned #cardDeck/);
  assert.match(panel, /body\.inspector-pinned #cardDeck/);
  assert.match(panel, /data-section-target="settings"/);
});
