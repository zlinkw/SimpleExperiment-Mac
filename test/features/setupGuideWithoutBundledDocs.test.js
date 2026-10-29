const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");
const {
  resolveSetupGuideSource,
  setupGuideOnlineUrl,
  extensionRepositoryUrl,
  SETUP_GUIDE_FILE_NAME,
  SETUP_GUIDE_ONLINE_FALLBACK_URL,
} = require("../../dist/features/SetupGuideSource.js");

// 0.5.400 发行包文档排除回归：
// resolver 纯函数 + 真实编译产物 showSetupGuideDocument 的 vm 运行分支（预览成功 / 预览失败文本回退 /
// 无 docs 在线且不读本地 / openExternal=false 提示 URL），以及向导控制流不变。
// vscode 全部用 spy 桩隔离：不发网络、不真正打开浏览器或编辑器。

test("resolver keeps file behavior when a local guide exists (source checkout / user-provided docs)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", SETUP_GUIDE_FILE_NAME), "# guide");
    const resolved = resolveSetupGuideSource(dir, "https://github.com/zlinkw/SimpleExperiment-Mac.git");
    assert.equal(resolved.kind, "file");
    assert.equal(resolved.path, path.join(dir, "docs", SETUP_GUIDE_FILE_NAME));
  }
  finally {
    console.log(`[fixture retained] ${dir}`);
  }
});

test("resolver falls back to the online repo doc when the shipped package has no docs (no ENOENT)", () => {
  const emptyInstall = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-empty-"));
  try {
    const resolved = resolveSetupGuideSource(emptyInstall, "https://github.com/zlinkw/SimpleExperiment-Mac.git");
    assert.equal(resolved.kind, "online");
    assert.equal(resolved.url, "https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md");
    assert.ok(!resolved.path, "online fallback must not expose a file path");
  }
  finally {
    console.log(`[fixture retained] ${emptyInstall}`);
  }
});

test("online url derives from repository forms and falls back when repository is missing", () => {
  assert.equal(setupGuideOnlineUrl("https://github.com/zlinkw/SimpleExperiment-Mac.git"), SETUP_GUIDE_ONLINE_FALLBACK_URL);
  assert.equal(setupGuideOnlineUrl("https://github.com/other-org/other-repo"), "https://github.com/other-org/other-repo/blob/master/docs/simple-experiment-setup.md");
  assert.equal(setupGuideOnlineUrl("git@github.com:other-org/other-repo.git"), "https://github.com/other-org/other-repo/blob/master/docs/simple-experiment-setup.md");
  assert.equal(setupGuideOnlineUrl(""), SETUP_GUIDE_ONLINE_FALLBACK_URL);
  assert.equal(setupGuideOnlineUrl(undefined), SETUP_GUIDE_ONLINE_FALLBACK_URL);
});

test("extensionRepositoryUrl accepts string and object repository forms", () => {
  assert.equal(extensionRepositoryUrl({ repository: "https://github.com/a/b.git" }), "https://github.com/a/b.git");
  assert.equal(extensionRepositoryUrl({ repository: { url: "git@github.com:a/b.git" } }), "git@github.com:a/b.git");
  assert.equal(extensionRepositoryUrl(undefined), undefined);
  assert.equal(extensionRepositoryUrl({}), undefined);
});

// —— 真实编译产物运行回归：vm 加载 dist/extension/legacy.js 中实际 showSetupGuideDocument ——

const legacyDist = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");

function extractMethodText(name, parameters = "") {
  const start = legacyDist.indexOf(`async ${name}(${parameters}) {`);
  assert.ok(start >= 0, `compiled method ${name} missing in dist/extension/legacy.js`);
  let depth = 0;
  for (let i = legacyDist.indexOf("{", start); i < legacyDist.length; i += 1) {
    if (legacyDist[i] === "{") depth += 1;
    else if (legacyDist[i] === "}") {
      depth -= 1;
      if (depth === 0) return legacyDist.slice(start, i + 1);
    }
  }
  return assert.fail(`unbalanced braces in ${name}`);
}

const importMatch = legacyDist.match(/const (\w+) = require\("\.\.\/features\/SetupGuideSource"\)/);
assert.ok(importMatch, "compiled SetupGuideSource import identifier not found");

function makeVscodeSpy(options = {}) {
  const calls = { executeCommand: [], openTextDocument: [], showTextDocument: [], openExternal: [], showWarning: [], showInfo: [] };
  const vscode = {
    Uri: {
      file: p => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` }),
      parse: u => ({ scheme: "https", toString: () => u }),
    },
    ViewColumn: { Active: -1 },
    commands: {
      async executeCommand(command, uri) {
        calls.executeCommand.push({ command, uri });
        if (options.previewFails) throw new Error("preview unavailable");
      },
    },
    workspace: {
      async openTextDocument(uri) {
        calls.openTextDocument.push(uri);
        return { uri };
      },
    },
    window: {
      async showTextDocument(document, options) {
        calls.showTextDocument.push({ document, options });
      },
      async showInformationMessage(message) {
        calls.showInfo.push(message);
      },
      async showWarningMessage(message) {
        calls.showWarning.push(message);
      },
    },
    env: {
      async openExternal(uri) {
        calls.openExternal.push(uri);
        return options.openExternalResult !== undefined ? options.openExternalResult : true;
      },
    },
  };
  return { vscode, calls };
}

function loadRealMethod(options) {
  const { vscode, calls } = makeVscodeSpy(options);
  const factory = new Function(importMatch[1], "vscode", `return { ${extractMethodText("showSetupGuideDocument")} };`);
  const target = factory(require("../../dist/features/SetupGuideSource.js"), vscode);
  return { target, calls };
}

function contextFor(extensionPath, repository) {
  return { context: { extensionPath, extension: repository ? { packageJSON: { repository } } : {} } };
}

const ONLINE_URL = "https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md";

test("runtime: local guide file opens through markdown.showPreview (original behavior)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-run-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", SETUP_GUIDE_FILE_NAME), "# guide");
    const { target, calls } = loadRealMethod();
    await target.showSetupGuideDocument.call(contextFor(dir, "https://github.com/zlinkw/SimpleExperiment-Mac.git"));
    assert.equal(calls.executeCommand.length, 1);
    assert.equal(calls.executeCommand[0].command, "markdown.showPreview");
    assert.equal(calls.executeCommand[0].uri.fsPath, path.join(dir, "docs", SETUP_GUIDE_FILE_NAME));
    assert.equal(calls.openTextDocument.length, 0);
    assert.equal(calls.openExternal.length, 0);
  }
  finally {
    console.log(`[fixture retained] ${dir}`);
  }
});

test("runtime: preview failure still falls back to openTextDocument for the same file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-run-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", SETUP_GUIDE_FILE_NAME), "# guide");
    const { target, calls } = loadRealMethod({ previewFails: true });
    await target.showSetupGuideDocument.call(contextFor(dir, "https://github.com/zlinkw/SimpleExperiment-Mac.git"));
    assert.equal(calls.openTextDocument.length, 1);
    assert.equal(calls.openTextDocument[0].fsPath, path.join(dir, "docs", SETUP_GUIDE_FILE_NAME));
    assert.equal(calls.showTextDocument.length, 1);
    assert.equal(calls.openExternal.length, 0);
  }
  finally {
    console.log(`[fixture retained] ${dir}`);
  }
});

test("runtime: shipped package without docs opens the online link and never touches local files", async () => {
  const emptyInstall = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-run-empty-"));
  try {
    const { target, calls } = loadRealMethod();
    await target.showSetupGuideDocument.call(contextFor(emptyInstall, "https://github.com/zlinkw/SimpleExperiment-Mac.git"));
    assert.equal(calls.openExternal.length, 1);
    assert.equal(calls.openExternal[0].toString(), ONLINE_URL);
    assert.equal(calls.executeCommand.length, 0);
    assert.equal(calls.openTextDocument.length, 0);
    assert.equal(calls.showWarning.length, 0);
  }
  finally {
    console.log(`[fixture retained] ${emptyInstall}`);
  }
});

test("runtime: openExternal=false surfaces a warning containing the URL (no silent failure)", async () => {
  const emptyInstall = fs.mkdtempSync(path.join(os.tmpdir(), "se-guide-run-offline-"));
  try {
    const { target, calls } = loadRealMethod({ openExternalResult: false });
    await target.showSetupGuideDocument.call(contextFor(emptyInstall, "https://github.com/zlinkw/SimpleExperiment-Mac.git"));
    assert.equal(calls.showWarning.length, 1);
    assert.match(calls.showWarning[0], /https:\/\/github\.com\/zlinkw\/SimpleExperiment-Mac\/blob\/master\/docs\/simple-experiment-setup\.md/);
  }
  finally {
    console.log(`[fixture retained] ${emptyInstall}`);
  }
});

// —— 两个原入口源码契约与控制流 ——

const legacy = readSource("src/extension.ts");

for (const entry of ["openSetupGuide", "openPptAutomationGuide"]) {
  test(`${entry} opens the guide only through showSetupGuideDocument (no direct docs path)`, () => {
    const start = legacy.indexOf(`async ${entry}()`);
    assert.ok(start >= 0, `missing method ${entry}`);
    const body = legacy.slice(start, start + 400);
    assert.match(body, /this\.showSetupGuideDocument\(\)/);
    assert.doesNotMatch(body, /path\.join\(this\.context\.extensionPath,\s*"docs"/);
  });
}

test("showSetupGuideDocument reads context.extension?.packageJSON and keeps preview inside the file branch", () => {
  const body = extractMethodText("showSetupGuideDocument");
  assert.match(body, /extension\?\.packageJSON/);
  assert.match(body, /if \(guide\.kind === "file"\)[\s\S]{0,400}markdown\.showPreview/);
  assert.match(body, /openExternal\(vscode\.Uri\.parse\(guide\.url\)\)/);
});

test("openSetupGuide still runs the wizard loop unchanged after the guide display", () => {
  const start = legacyDist.indexOf("async openSetupGuide() {");
  assert.ok(start >= 0);
  const body = legacyDist.slice(start, start + 2600);
  const showIndex = body.indexOf("this.showSetupGuideDocument()");
  const loopIndex = body.indexOf("for (let step = 0; step < SETUP_GUIDE_MAX_STEPS; step += 1)");
  assert.ok(showIndex >= 0 && loopIndex > showIndex, "guide display must precede the unchanged wizard loop");
  for (const marker of ['choice === "打开服务器设置"', 'choice === "打开扩展管理"', 'choice === "添加 Worker"', 'choice === "选择项目并继续"', 'choice === "识别工作区"']) {
    assert.ok(body.indexOf(marker) > loopIndex, `wizard marker ${marker} must stay after the loop start`);
  }
});

test("AI integration entry is pinned in settings and its full multiline task reaches the clipboard", async () => {
  const guides = require("../../dist/features/SetupGuideSource.js");
  const repository = require("../../package.json").repository.url;
  assert.equal(guides.experimentIntegrationGuideUrl("git@github.com:other/project.git"), "https://github.com/other/project/blob/master/docs/experiment-integration.md");
  const html = require("../../dist/ui/PanelHtml.js").renderPanelHtml();
  const start = html.indexOf('data-anchor="settings-integration-guide"');
  assert.ok(start > 0 && start < html.indexOf('data-anchor="settings-layout"'));
  const match = html.slice(start).match(/<button\b[^>]*data-command="copyText"[^>]*data-text="([^"]+)"/);
  assert.ok(match, "one-click copy must use the existing clipboard command");
  const payload = match[1].replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(payload, guides.experimentIntegrationAiTask(repository));
  assert.ok(html.includes('href="' + guides.experimentIntegrationGuideUrl(repository) + '"'));
  assert.match(payload, /MultiModal/); assert.match(payload, /不凭记忆/); assert.match(payload, /confirm\/pathConfirmed/);
  const copied = [];
  const vscode = { env: { clipboard: { writeText: async text => copied.push(text) } }, window: { showInformationMessage() {}, showWarningMessage: () => assert.fail("nonempty task") } };
  const target = new Function("vscode", `return { ${extractMethodText("copyTextFromUi", "message")} };`)(vscode);
  await target.copyTextFromUi({ text: payload });
  assert.deepEqual(copied, [payload]);
});
