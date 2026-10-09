const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

function loadHelpers() {
  const source = readSource("src/extension.ts");
  const start = source.indexOf("const PROJECT_UI_LAYOUT_PATH");
  const end = source.indexOf("function compactLocalPlansForWebview");
  assert.ok(start > 0 && end > start, "helper slice missing");
  const normalizeStart = source.indexOf("function normalizeUiLayout(input)");
  const clampEnd = source.indexOf("function arrayFromRecord");
  assert.ok(normalizeStart > 0 && clampEnd > normalizeStart, "normalize helpers missing");
  const defaultStart = source.indexOf("const defaultUiLayout =");
  const defaultEnd = source.indexOf("const uiActionCommands");
  assert.ok(defaultStart > 0 && defaultEnd > defaultStart, "default layout missing");
  const defaultUiSectionOrderStart = source.indexOf("const defaultUiSectionOrder");
  const defaultUiSectionOrderEnd = source.indexOf("const defaultUiLayout =");
  assert.ok(defaultUiSectionOrderStart > 0 && defaultUiSectionOrderEnd > defaultUiSectionOrderStart);
  const uiActionStart = source.indexOf("const uiActionCommands");
  const uiActionEnd = source.indexOf("const actionCommandMap");
  assert.ok(uiActionStart > 0 && uiActionEnd > uiActionStart);
  const prelude = [
    source.slice(defaultUiSectionOrderStart, defaultUiSectionOrderEnd),
    source.slice(defaultStart, defaultEnd),
    source.slice(uiActionStart, uiActionEnd),
    source.slice(normalizeStart, clampEnd),
  ].join("\n").replace(/new Set<WebviewActionCommand>/g, "new Set");
  const helpers = source.slice(start, end);
  const sandbox = {
    fs: {
      readFile: fs.promises.readFile,
      writeFile: fs.promises.writeFile,
      mkdir: fs.promises.mkdir,
      unlink: fs.promises.unlink,
    },
    path,
    console,
    writeAtomicPluginStateJson: async (file, value) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
  };
  vm.createContext(sandbox);
  const selected = prelude + "\n" + helpers + "\nthis.exports = { PROJECT_UI_LAYOUT_PATH, readProjectUiLayoutState, writeProjectUiLayoutState, projectUiLayoutState, normalizeUiLayout, defaultUiLayout };";
  vm.runInContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox.exports;
}

test("project ui layout state persists under simple_cluster/ui", async () => {
  const helpers = loadHelpers();
  assert.equal(helpers.PROJECT_UI_LAYOUT_PATH, "simple_cluster/ui/ui_layout.json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-ui-layout-"));
  const layout = helpers.projectUiLayoutState(helpers.normalizeUiLayout({
    ...helpers.defaultUiLayout,
    manual: true,
    order: ["plans", "results", "tasks"],
  }));
  await helpers.writeProjectUiLayoutState(root, layout);
  const file = path.join(root, "simple_cluster", "ui", "ui_layout.json");
  assert.equal(fs.existsSync(file), true);
  const loaded = await helpers.readProjectUiLayoutState(root);
  assert.equal(loaded.manual, true);
  assert.ok(Array.isArray(loaded.order));
  assert.equal(loaded.order[0], "plans");
  await helpers.writeProjectUiLayoutState(root, undefined);
  assert.equal(fs.existsSync(file), true);
  assert.equal(await helpers.readProjectUiLayoutState(root), undefined);
});

test("extension wires project ui layout helpers", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /simple_cluster\/ui\/ui_layout\.json/);
  assert.match(source, /loadProjectUiLayoutState/);
  assert.match(source, /persistProjectUiLayoutState/);
  assert.match(source, /this\.projectUiLayout = projectUiLayoutState\(layout\)/);
  assert.doesNotMatch(source, /workspaceState\.update\(keys\.uiProjectLayout, projectUiLayoutState\(layout\)\)/);
});

