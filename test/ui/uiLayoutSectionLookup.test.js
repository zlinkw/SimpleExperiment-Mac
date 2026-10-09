const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadLayoutNormalizer() {
  const order = Object.freeze(["sync", "plans", "gpu", "tmux", "execution", "results", "diagnostics", "settings"]);
  const keys = new Set(order);
  const sandbox = {
    RESOURCE_TREE_SECTION_ORDER: order,
    RESOURCE_TREE_SECTION_KEYS: {
      checks: 0,
      has(value) {
        this.checks += 1;
        return keys.has(value);
      },
    },
    pinnedCommandDefaults: [],
    savedActionLimits: [],
    normalizeResourceTreeChildOrders(value) { return value; },
    normalizeLayoutColumns(value) { return value; },
    normalizePinnedCommands(value) { return value; },
    normalizeInspectorCustomGroups(value) { return value || {}; },
    normalizeSavedButtonActions(value, limit) {
      sandbox.savedActionLimits.push(limit);
      return value;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("normalizeUiLayout")}\nthis.normalize = normalizeUiLayout;`, sandbox);
  return sandbox;
}

test("UI layout normalization reuses fixed section order and lookup set", () => {
  assert.match(panel, /const RESOURCE_TREE_SECTION_ORDER = Object\.freeze\(\["sync", "plans", "gpu", "tmux", "execution", "results", "diagnostics", "settings"\]\)/);
  assert.match(panel, /const RESOURCE_TREE_SECTION_KEYS = new Set\(RESOURCE_TREE_SECTION_ORDER\)/);
  const source = extractFunction("normalizeUiLayout");
  assert.match(source, /RESOURCE_TREE_SECTION_KEYS\?\.has\(item\)/);
  assert.match(source, /RESOURCE_TREE_SECTION_ORDER\.filter\(\(item\) => !incomingSet\?\.has\(item\)\)/);
  assert.doesNotMatch(source, /const defaults =/);
  assert.doesNotMatch(source, /\.includes\(/);
});

test("UI layout normalization preserves custom order duplicates and adjacent fields", () => {
  const sandbox = loadLayoutNormalizer();
  const layout = {
    order: ["execution", "unknown", "overview", "execution"],
    collapsed: { gpu: true },
    resourceTreeChildren: { plans: ["plan:a"] },
    columns: { tree: 300, inspector: 380 },
    pinnedCommands: ["status"],
    detailActions: [{ id: "detail" }],
    pinnedActions: [{ id: "pinned" }],
    manual: true,
    treePinned: true,
    inspectorPinned: false,
  };
  const normalized = sandbox.normalize(layout);

  assert.deepEqual(Array.from(normalized.order), ["execution", "execution", "sync", "plans", "gpu", "tmux", "results", "diagnostics", "settings"]);
  assert.equal(sandbox.RESOURCE_TREE_SECTION_KEYS.checks, layout.order.length + 8);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.collapsed)), { settings: false, sync: false, diagnostics: true, execution: false, gpu: true });
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.resourceTreeChildren)), layout.resourceTreeChildren);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.columns)), layout.columns);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.inspectorCustomGroups)), {});
  assert.deepEqual(sandbox.savedActionLimits, []);
  assert.equal(normalized.manual, true);
  assert.equal(normalized.treePinned, true);
  assert.equal(normalized.inspectorPinned, false);
});
