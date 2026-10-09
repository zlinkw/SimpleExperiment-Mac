const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panelSource = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

// Minimal node model: only the attribute lookups resolveResourceScrollTarget actually performs.
function node(attributes, children) {
  const item = {
    id: attributes.id || attributes["data-anchor"] || attributes["data-section"] || "node",
    attributes,
    children: children || [],
    parent: null,
  };
  item.children.forEach((child) => { child.parent = item; });
  item.getAttribute = (name) => (name in item.attributes ? item.attributes[name] : null);
  item.matches = (selector) => {
    const match = /^\[([a-z-]+)="(.*)"\]$/.exec(selector);
    if (!match) return false;
    return item.getAttribute(match[1]) === match[2];
  };
  item.closest = (selector) => {
    const bare = /^\[([a-z-]+)\]$/.exec(selector);
    let current = item;
    while (current) {
      if (bare ? current.getAttribute(bare[1]) !== null : current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  };
  item.querySelector = (selector) => {
    for (const child of item.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  return item;
}

function loadResolver(mainNode) {
  const sandbox = {
    el: (id) => (id === "mainColumn" ? mainNode : null),
    cssEscape: (value) => String(value),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("resolveResourceScrollTarget"),
    extractFunction("anchorOutsideSection"),
    "this.resolve = resolveResourceScrollTarget;",
    "this.outside = anchorOutsideSection;",
  ].join("\n"), sandbox);
  return sandbox;
}

function buildMain() {
  return node({}, [
    node({ "data-section": "tasks" }, [
      node({ "data-anchor": "tasks-list", id: "tasks-list" }),
      node({ "data-anchor": "shared-anchor", id: "tasks-shared" }),
    ]),
    node({ "data-section": "operations" }, [
      node({ "data-anchor": "operations-list", id: "operations-list" }),
    ]),
    // 单链第二步：旧 sync/sync-publish fixture 已迁移到 settings/settings-chain-overview
    node({ "data-section": "settings", "data-anchor": "settings" }, [
      node({ "data-anchor": "settings-chain-overview", id: "settings-chain-overview" }),
    ]),
  ]);
}

test("an anchor inside the requested section always wins", () => {
  const resolver = loadResolver(buildMain());
  assert.equal(resolver.resolve("tasks", "tasks-list").id, "tasks-list");
  assert.equal(resolver.resolve("operations", "operations-list").id, "operations-list");
});

test("a same-named anchor in another section does not hijack the jump", () => {
  const resolver = loadResolver(buildMain());
  const target = resolver.resolve("operations", "shared-anchor");
  assert.equal(target.getAttribute("data-section"), "operations", "must stay in the requested section");
  assert.notEqual(target.id, "tasks-shared");
});

test("a global anchor is still used when the requested section is absent", () => {
  const resolver = loadResolver(buildMain());
  assert.equal(resolver.resolve("missing-section", "tasks-list").id, "tasks-list");
});

test("the settings chain overview resolves without a sync publish fallback", () => {
  const resolver = loadResolver(buildMain());
  // 旧 syncFallback 已删除：未知 anchor 不再误跳 sync-publish，而是回落到 section 容器
  assert.doesNotMatch(panelSource, /syncFallback/);
  assert.doesNotMatch(panelSource, /data-anchor="sync-publish"/);
  assert.equal(resolver.resolve("settings", "settings-chain-overview").id, "settings-chain-overview");
  const fallback = resolver.resolve("settings", "settings-anything");
  assert.equal(fallback.getAttribute("data-section"), "settings");
});

test("an unknown anchor falls back to the section container", () => {
  const resolver = loadResolver(buildMain());
  const target = resolver.resolve("tasks", "no-such-anchor");
  assert.equal(target.getAttribute("data-section"), "tasks");
  assert.equal(resolver.resolve("nope", "also-nope"), null);
});

test("section ownership is decided by the nearest data-section ancestor", () => {
  const resolver = loadResolver(buildMain());
  const main = buildMain();
  const taskShared = main.querySelector('[data-anchor="shared-anchor"]');
  assert.equal(resolver.outside(taskShared, "operations"), true);
  assert.equal(resolver.outside(taskShared, "tasks"), false);
  assert.equal(resolver.outside(null, "tasks"), false);
});

test("a missing main column resolves to nothing", () => {
  const resolver = loadResolver(null);
  assert.equal(resolver.resolve("tasks", "tasks-list"), null);
});
