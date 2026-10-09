const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");

function panelSource() {
  // PanelHtml.ts 现为回退 facade（委托 legacy），语义断言以 legacy 为准
  return fs.readFileSync(path.join(root, "src", "ui", "PanelHtml.legacy.ts"), "utf8");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = source.indexOf(end, startIndex + start.length);
  return endIndex < 0 ? source.slice(startIndex) : source.slice(startIndex, endIndex);
}

test("card decoration gives each collapse button its section id", () => {
  const source = between(panelSource(), "    function decorateCards() {", "    function decorateCommandTooltips() {");
  assert.ok(source);
  const head = { tools: null, querySelector: () => head.tools, appendChild(node) { head.tools = node; } };
  const card = { dataset: { section: "results" }, classList: { contains: () => false }, querySelector: () => head };
  const document = { querySelectorAll: () => [card], createElement: () => ({ dataset: {}, innerHTML: "" }) };
  vm.runInNewContext(source + "decorateCards()", { document, layoutEdit: false, escAttr: value => value });
  assert.match(head.tools.innerHTML, /data-collapse-section="results"/);
  assert.doesNotMatch(head.tools.innerHTML, /title="[^"]+"="results"/);
});

test("panel uses draggable three column workbench with searchable resource tree", () => {
  const source = panelSource();

  assert.match(source, /<aside id="resourceTree" class="resourceTree"/);
  assert.match(source, /id="resourceTreeSearch"/);
  assert.match(source, /resourceTreeFilter/);
  assert.match(source, /data-search-text/);
  assert.match(source, /overscroll-behavior: contain/);
  assert.match(source, /scroll-snap-type: y proximity/);
  assert.match(source, /tree-empty/);
  assert.match(source, /id="resourceTreeInspector"/);
  assert.match(source, /data-section-target/);
  assert.match(source, /function renderResourceTree/);
  assert.match(source, /function setupResourceTreeObserver/);
  assert.match(source, /function updateResourceTreeActiveSection/);
  assert.match(source, /function renderResourceTreeInspector/);
  assert.match(source, /renderResourceTreeInspector\(activeResourceSection, activeResourceAnchor\)/);
  assert.match(source, /\.tree-inspector-facts/);
  assert.match(source, /\.tree-group-label/);
  assert.match(source, /\.tree-child-list/);
  assert.match(source, /\.tree-object/);
  assert.match(source, /function treeChildList/);
  assert.match(source, /function treeObjectItem/);
  assert.match(source, /function serverTreeObjects/);
  assert.match(source, /function gpuTreeObjects/);
  assert.match(source, /function taskTreeObjects/);
  assert.match(source, /const groups = order\.map\(\(section\) =>/);
  assert.doesNotMatch(source, /groups\.find\(\(item\) => item\.label === entry\.label\)/);
});

test("panel exposes resizable columns, collapse controls, and persisted layout fields", () => {
  const panel = panelSource();
  // extension.ts 现为薄 facade（委托 legacy），语义断言以 legacy 为准
  const extension = fs.readFileSync(path.join(root, "src", "extension", "legacy.ts"), "utf8");

  assert.match(panel, /#cardDeck \{ --tree-col: 280px; --inspector-col: 360px;/);
  assert.match(panel, /grid-template-columns: var\(--tree-col\) 8px minmax\(var\(--main-min\), 1fr\) 8px var\(--inspector-col\)/);
  assert.match(panel, /class="layoutResizer left"/);
  assert.match(panel, /class="layoutResizer right"/);
  assert.match(panel, /data-resize-column="tree"/);
  assert.match(panel, /data-resize-column="inspector"/);
  assert.match(panel, /function beginLayoutResize/);
  assert.match(panel, /function updateLayoutResize/);
  assert.match(panel, /function finishLayoutResize/);
  assert.match(panel, /collapseAllSections/);
  assert.match(panel, /expandAllSections/);
  assert.match(panel, /function setAllSectionsCollapsed/);
  assert.match(panel, /function normalizeLayoutColumns/);
  assert.match(panel, /currentUiLayout\.columns/);
  assert.match(extension, /columns: \{ tree: 280, inspector: 360 \}/);
  assert.match(extension, /inspectorCustomGroups: normalizeInspectorCustomGroups/);
  assert.match(extension, /function normalizeUiLayoutColumns/);
  assert.match(extension, /function normalizeUiButtonActions/);
  assert.match(extension, /function normalizeUiButtonPayload/);
  assert.match(extension, /clampUiNumber\(record\.tree, 220, 420/);
});

test("extension reuses fixed UI layout validation sets", () => {
  const extension = fs.readFileSync(path.join(root, "src", "extension", "legacy.ts"), "utf8");
  const helpers = between(extension, "function normalizeUiLayout(input)", "function clampUiNumber");

  assert.match(extension, /const UI_LAYOUT_SECTION_KEYS = new Set\(defaultUiSectionOrder\)/);
  assert.match(extension, /normalizeInspectorCustomGroups\(input\.inspectorCustomGroups\)/);
  assert.match(extension, /const UI_BUTTON_ACTION_COMMANDS = new Set\(/);
  assert.match(extension, /const UI_BUTTON_PAYLOAD_KEYS = new Set\(/);
  assert.match(helpers, /UI_LAYOUT_SECTION_KEYS\.has/);
  assert.match(helpers, /normalizeInspectorCustomGroups\(input\.inspectorCustomGroups\)/);
  assert.match(helpers, /UI_BUTTON_ACTION_COMMANDS\.has/);
  assert.match(helpers, /UI_BUTTON_PAYLOAD_KEYS\.has/);
  assert.doesNotMatch(helpers, /const (?:known|allowed) = new Set/);
});

test("right inspector supports pinned actions and publish sync command group", () => {
  const source = panelSource();

  assert.match(source, /<aside id="workbenchInspector" class="workbenchInspector"/);
  assert.match(source, /function renderWorkbenchInspector/);
  assert.match(source, /function inspectorCustomGroupsState/);
  assert.match(source, /function workbenchInspectorActions/);
  assert.match(source, /function workbenchInspectorEvents/);
  assert.match(source, /function renderInspectorEvent/);
  assert.match(source, /function renderInspectorCustomGroups/);
  assert.match(source, /function inspectorActionButton/);
  assert.match(source, /\.pinnedActions/);
  assert.match(source, /data-inspector-add/);
  assert.match(source, /pinnedCommandDefaults/);
  assert.match(source, /normalizePinnedCommands/);
  assert.match(source, /pinnedCommands/);
  assert.match(source, /sync: \[\["/);
  for (const command of [
    "publishGithub",
    "syncGithub",
    "overwriteGithub",
    "uploadProjectToHub",
    "uploadProjectToWorkers",
    "distributeCodeToWorkers",
    "deployLatestAgent",
    "configureDownloadScope",
  ]) {
    assert.match(source, new RegExp(`"${command}"`));
  }
});

test("right and pinned actions enforce explicit scoped context", () => {
  const source = panelSource();
  const actionButtonBlock = between(source, "function actionButton", "function rowActionButton");
  const scopedBlock = between(source, "function scopedActionMissingContextReason", "function hasTaskObjectTarget");
  const refreshBlock = between(source, "function refreshContextualActionButtons", "function planButtonDisableReason");
  const stateSignatureBlock = between(source, "function contextActionStateSignature", "function contextRefreshPayloadFromButton");
  const auditBlock = between(source, "function auditButtonPayloadWarnings", "function genericButtonHelp");

  assert.match(source, /const taskObjectScopedCommands = new Set/);
  assert.match(source, /const taskBatchScopedCommands = new Set/);
  assert.match(source, /const endpointScopedCommands = new Set/);
  assert.match(actionButtonBlock, /actionButtonDisableReason\(command, pendingPayload, options\)/);
  assert.match(actionButtonBlock, /data-context-action="true"/);
  assert.match(scopedBlock, /storedAction && taskObjectScopedCommands\?\.has\(command\)/);
  assert.match(scopedBlock, /请从任务行重新加入工作详情或右侧置顶/);
  assert.match(scopedBlock, /endpointScopedCommands\?\.has\(command\)/);
  assert.match(scopedBlock, /explicitPlanFileCommands\?\.has\(command\)/);
  assert.match(refreshBlock, /button\[data-context-action="true"\], button\[data-batch-selected="true"\]/);
  assert.match(refreshBlock, /contextRefreshPayloadFromButton\(button, command, options\)/);
  assert.doesNotMatch(refreshBlock, /payloadFromButton\(button\)/);
  assert.doesNotMatch(refreshBlock, /configInputValue\(/);
  assert.doesNotMatch(refreshBlock, /plan-preview-/);
  assert.match(refreshBlock, /actionButtonDisableReason\(command, payload/);
  assert.match(stateSignatureBlock, /const hostSignature = String\(\(state && state\.contextActionSignature\) \|\| ""\)/);
  assert.match(stateSignatureBlock, /if \(hostSignature\) return hostSignature/);
  assert.doesNotMatch(stateSignatureBlock, /objectReferenceKey\(state\),/);
  for (const key of ["state.capabilities", "state.realtime", "state.selection", "state.workerProbes", "state.plans", "state.recentPlans"]) {
    assert.match(stateSignatureBlock, new RegExp(`objectReferenceKey\\(${key.replace(".", "\\.")}\\)`));
  }
  for (const key of ["state.connectionMode", "state.lastSnapshotAt", "state.debugBundlePath"]) {
    assert.match(stateSignatureBlock, new RegExp(key.replace(".", "\\.")));
  }
  assert.match(source, /function contextRefreshPayloadFromButton/);
  assert.match(source, /requiresExplicitSavedPlanPayload/);
  assert.match(auditBlock, /scopedActionMissingContextReason\(command, buttonDatasetActionPayload\(button\)/);
  assert.match(auditBlock, /closest\("\.pinnedActions"\)/);
});

test("resource tree active state does not rewrite inspector during realtime refresh", () => {
  const source = panelSource();
  const updateActive = between(source, "function updateResourceTreeActiveSection", "function renderResourceTreeInspector");
  const renderFunction = between(source, "function render(state)", "function commandNeedsLoading");
  const clickHandler = between(source, 'const treeTarget = event.target.closest("[data-section-target]");', "const collapse = event.target.closest");

  assert.doesNotMatch(updateActive, /renderWorkbenchInspector|innerHTML|renderResourceTreeInspector/);
  assert.equal((renderFunction.match(/renderWorkbenchInspector\(state\)/g) || []).length, 1);
  assert.match(clickHandler, /renderResourceTreeInspector\(activeResourceSection, activeResourceAnchor\)/);
  assert.match(clickHandler, /renderWorkbenchInspector\(lastState \|\| \{\}\)/);
  assert.match(source, /\.tree-inspector \{[^}]*height: 34px;[^}]*overflow: hidden;/);
  assert.match(source, /\.tree-inspector-facts \{ display: none;/);
  assert.match(source, /\.tree-inspector-action \{ display: none;/);
});

test("resource tree includes stable semantic sections including publish sync", () => {
  const source = panelSource();

  // 目标序：sync→plans→gpu→tmux→execution→results→diagnostics→settings（settings 恒尾）；
  // servers 仅以 hidden 兼容节保留（data-legacy="servers-hidden-merged-into-sync"），overview 仅后端尾兼容，前端不再断言
  for (const section of ["sync", "plans", "gpu", "tmux", "execution", "results", "diagnostics", "settings"]) {
    assert.match(source, new RegExp(`item\\("${section}"`));
  }
  assert.match(source, /data-legacy="servers-hidden-merged-into-sync"/);
  assert.match(source, /normalizeUiLayout\(currentUiLayout\)\.order/);
  assert.doesNotMatch(source, /normalizeUiLayout\(currentUiLayout\)\.order\.concat\(\["sync"\]\)/);
  assert.match(source, /resourceTreeMeta/);
  assert.match(source, /aria-current/);
  assert.match(source, /\.tree-item\.is-current/);
});

test("resource tree search text reuses node identities and refreshes replacements", () => {
  const source = panelSource();
  const block = between(source, "function resourceTreeSearchText", "function treeAnchorId");
  const sandbox = {
    resourceTreeSearchTextCache: new WeakMap(),
    asArray(value) { return Array.isArray(value) ? value : []; },
  };
  vm.createContext(sandbox);
  vm.runInContext(block + "\nthis.searchText = resourceTreeSearchText;", sandbox);

  const child = { label: "Worker A" };
  const node = { label: "GPU", children: [child] };
  const first = sandbox.searchText(node);
  node.label = "Changed";
  child.label = "Changed child";
  assert.equal(sandbox.searchText(node), first);
  const replacement = sandbox.searchText({ label: "Changed", children: [{ label: "Changed child" }] });
  assert.match(replacement, /changed/);
  assert.match(replacement, /changed child/);
  assert.equal(sandbox.searchText('<i data-search-text="GPU Worker"></i>'), "gpu worker");
});
