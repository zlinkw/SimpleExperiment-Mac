const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const policy = require("../../scripts/package-content-policy");

// 发行包内容策略验收（2026-10-21 用户返修要求）：
// 1) 单源 JSON 规则；JS 与 Python 分类器对同一矩阵逐项等价；
// 2) 最终 zip 层的通过/失败回归（含 docs、嵌套 README、test/、备份、pycache、法律/运行文件保留）；
// 3) 诊断只含路径与类别。禁止仅测 .vscodeignore 文本。

const CASES = [
  ["docs/guide.md", "docs"],
  ["docs/nested/forensics_baseline_report.md", "forensics"],
  ["test/features/anything.test.js", "dev-tests"],
  ["tests/test_check_static_report.py", "dev-tests"],
  ["dist/cluster_agent.py.patched", "backup"],
  ["a.bak", "backup"],
  ["old.orig", "backup"],
  ["dist/runtime/__pycache__/cluster_agent.cpython-311.pyc", "python-cache"],
  ["standalone.pyc", "python-cache"],
  ["msg.txt", "scratch"],
  ["notmsg.txt", undefined],
  [".packaging-a-final.cmd", "scratch"],
  ["scripts/.tmp-helper.js", "scratch"],
  ["build.exitcode", "scratch"],
  ["CHANGELOG.md", "changelog"],
  ["CHANGELOG", "changelog"],
  ["extension/changelog.md", "changelog"],
  ["dist/anything.vsix", "archive"],
  ["runtime.log", "log"],
  ["ui/README.md", "doc-markdown"],
  ["notes.MD", "doc-markdown"],
  ["README.md", undefined],
  ["readme.md", undefined],
  ["LICENSE.txt", undefined],
  ["LICENSE", undefined],
  ["NOTICE.txt", undefined],
  ["dist/templates/project-adapter/README.md", "doc-markdown"],
  ["dist/templates/project-adapter/claims.md", "doc-markdown"],
  ["dist/templates/project-adapter/output_contract_guide.md", "doc-markdown"],
  ["dist/features/SetupGuideSource.js", undefined],
  ["package.json", undefined],
  ["simpleex.cmd", undefined],
  ["extension/dist/runtime/cluster_agent.py.sha256", undefined],
  ["Docs/UPPER.MD", "docs"],
  ["extension/extension/double-prefix.md", "doc-markdown"],
  // 运行时模板精确白名单：仅豁免 doc-markdown 文档分类；同目录安全规则照常生效
  ["dist/templates/extra.md", "doc-markdown"],
  ["dist/templates/forensics_report.md", "forensics"],
  ["dist/templates/x.patched", "backup"],
  ["dist/templates/.tmp-x", "scratch"],
  ["dist/templates/x.log", "log"],
  ["dist/templates/project-adapter/claims.MD", "doc-markdown"],
  // r25-A 实际泄漏路径回归：开发锁/运行缓存/receipt/tsc 增量元信息必拒，必要资源不误排
  [".test-workflow-batch.lock/owner.json", "dev-lock"],
  ["extension/.test-workflow-batch.lock/owner.json", "dev-lock"],
  ["simple_cluster/cache/tsc/linux-x64-abcd/state.json", "workflow-cache"],
  ["simple_cluster/reports/test-workflow/batch/run.json", "workflow-cache"],
  ["simple_cluster/cache/npm/_cacache/index-v5/x", "workflow-cache"],
  ["tsconfig.tsbuildinfo", "compile-metadata"],
  ["dist/tsconfig.tsbuildinfo", "compile-metadata"],
  ["dist/panel-build-manifest.json", undefined],
  // 用户长期裁决 2026-10-24：旧嵌套 SimpleSFTP 捆绑副本必拒（相对+vsix 归档前缀两形态）；仅限点名路径，其他 extensions 不误伤
  ["extensions/simple-sftp/package.json", "bundled-sftp"],
  ["extension/extensions/simple-sftp/agent-lifecycle.js", "bundled-sftp"],
  ["extensions/other-tool/index.js", undefined],
  // 统一规范化语义：反复 ./、大小写、单次 extension/ 前缀
  ["././DOCS/g.md", "docs"],
  ["Extension/Docs/g.md", "docs"],
  ["extension/./docs/x.md", "docs"],
  ["extension\\docs\\z.md", "docs"],
  ["./LICENSE.txt", undefined],
];

test("JS classifier matches the full pass/reject matrix (case-insensitive, ordered rules)", () => {
  for (const [input, expected] of CASES) {
    assert.equal(policy.classify(input), expected, `JS classify(${input})`);
  }
});

// 统一解释器选择：仅当解释器本身缺失（spawn ENOENT）才尝试下一个候选；
// 解释器存在但执行失败必须原样返回失败，不得换解释器掩盖。
function runPython(args, input) {
  const scriptIndex = args.indexOf("-c");
  if (scriptIndex >= 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-policy-python-"));
    const file = path.join(dir, "probe.py");
    fs.writeFileSync(file, args[scriptIndex + 1], "utf8");
    args = [...args.slice(0, scriptIndex), file, ...args.slice(scriptIndex + 2)];
    console.log("kept Python fixture at " + dir);
  }
  let last = null;
  const executables = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const exe of executables) {
    const result = spawnSync(exe, args, { encoding: "utf8", timeout: 10000, windowsHide: true, input });
    if (result.error && result.error.code === "ENOENT") {
      last = result;
      continue;
    }
    return result;
  }
  return last;
}

test("normalizePath is idempotent (single representation for nested paths)", () => {
  for (const [input] of CASES) {
    const once = policy.normalizePath(input);
    assert.equal(policy.normalizePath(once), once, `normalize not idempotent for ${input}`);
  }
});

test("JS and Python classifiers are equivalent on the same matrix", () => {
  const spec = JSON.stringify(CASES);
  const script = `
import json,sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "..", "..", "scripts"))})
import package_content_policy as p
cases=json.loads(sys.stdin.read())
out=[p.classify(case[0]) for case in cases]
print(json.dumps(out))
`;
  const result = runPython(["-B", "-I", "-c", script], spec);
  assert.equal(result.status, 0, `python classifier failed: ${result.stderr}`);
  const pyOut = JSON.parse(result.stdout);
  CASES.forEach((entry, index) => {
    const expected = entry[1] === undefined ? null : entry[1];
    assert.equal(pyOut[index], expected, `python classify(${entry[0]})`);
    const jsValue = policy.classify(entry[0]);
    assert.equal(jsValue === undefined ? null : jsValue, pyOut[index], `js/python mismatch on ${entry[0]}`);
  });
});

// 夹具内容写入唯一虚构 sentinel（绝非真凭据），用于证明诊断只输出路径/类别不含文件内容。
const FIXTURE_SENTINEL = "FICTIONAL_SENTINEL_9c4e_not_a_real_credential";

function makeZip(zipPath, entries) {
  const script = `
import json,sys,zipfile
entries=json.loads(sys.stdin.read())
with zipfile.ZipFile(entries[0],'w') as z:
    for name in entries[1:]:
        z.writestr(name, entries[2].encode())
`;
  const result = runPython(["-B", "-I", "-c", script], JSON.stringify([zipPath, ...entries, FIXTURE_SENTINEL]));
  assert.equal(result.status, 0, `zip build failed: ${result.stderr}`);
}

function runZipCli(zipPath) {
  return runPython(["-B", "-I", path.join(__dirname, "..", "..", "scripts", "package_content_policy.py"), "--zip", zipPath]);
}

const GOOD_LISTING = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/README.md",
  "extension/LICENSE.txt",
  // Mac 适配：发行 bin 为 simpleex-mac（Windows 为 simpleex），打包根命令随身份变化。
  "extension/dist/mac/Bootstrap.js",
  "extension/dist/cli.js",
  "extension/scripts/check-static.js",
  "extension/dist/extension.js",
  "extension/dist/runtime/RuntimeManifest.json",
  "extension/dist/runtime/RuntimeManifest.js",
  "extension/dist/runtime/cluster_agent.py",
  "extension/dist/runtime/cluster_agent.py.sha256",
  "extension/dist/runtime/cluster_scheduler.py",
  "extension/dist/runtime/cluster_scheduler.py.sha256",
  "extension/dist/panel-build-manifest.json",
  "extension/dist/features/SetupGuideSource.js",
];

test("zip-level regression: compliant final archive passes the policy CLI (exit 0)", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-policy-ok-"));
  try {
    const zip = path.join(dir, "good.vsix");
    makeZip(zip, GOOD_LISTING);
    const result = runZipCli(zip);
    assert.equal(result.status, 0, `expected pass, stderr=${result.stderr}`);
  }
  finally {
    console.log("Retained policy fixture: " + dir);
  }
});

test("zip-level regression: docs/nested README/tests/backup/pycache entries fail with path+category only", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-policy-bad-"));
  try {
    const zip = path.join(dir, "bad.vsix");
    makeZip(zip, [
      ...GOOD_LISTING,
      "extension/docs/forensics_baseline_NWPU_report.md",
      "extension/dist/ui/README.md",
      "extension/test/x.test.js",
      "extension/tests/test_dev.py",
      "extension/dist/runtime/cluster_agent.py.patched",
      "extension/dist/runtime/__pycache__/cluster_agent.pyc",
      "extension/CHANGELOG.md",
    ]);
    const result = runZipCli(zip);
    assert.equal(result.status, 1, "violating archive must fail");
    const output = `${result.stdout}\n${result.stderr}`;
    for (const marker of ["forensics", "doc-markdown", "dev-tests", "backup", "python-cache", "changelog"]) {
      assert.ok(output.includes(`<category:${marker}>`), `missing category ${marker} in diagnostics`);
    }
    assert.ok(output.includes("dist/ui/readme.md"), "nested readme violation must be listed by path");
    // 诊断只含路径与类别：每个夹具成员都写入了 FIXTURE_SENTINEL，输出中必须零出现（不泄漏文件内容）
    assert.ok(!output.includes(FIXTURE_SENTINEL), "diagnostics must never echo file contents");
  }
  finally {
    console.log("Retained policy fixture: " + dir);
  }
});

test("checkListing reports missing required files and the toolchain readme exception", () => {
  const stripped = GOOD_LISTING.filter(name => !["extension/dist/runtime/cluster_agent.py.sha256", "extension/README.md"].includes(name));
  const violations = policy.checkListing(stripped);
  assert.ok(violations.some(line => line.startsWith("missing required dist/runtime/cluster_agent.py.sha256")));
  assert.ok(violations.some(line => line.includes("toolchain-exception root readme.md")));
});

// ── r21 unused-compiled 交集排除：单源一致性 / 规范化别名 / 保留闭包不相交 ──────────────
const UNUSED_RULE = policy.POLICY.forbidden_ordered.find(rule => rule.category === "unused-compiled");
const UNUSED_PATHS = UNUSED_RULE ? UNUSED_RULE.paths : [];

test("unused-compiled exact paths classify on both classifiers incl normalization variants (r21 #3/#4)", () => {
  assert.ok(UNUSED_PATHS.length > 0, "单源必须携带 unused-compiled paths");
  assert.equal(new Set(UNUSED_PATHS).size, UNUSED_PATHS.length, "排除表禁止重复条目");
  const variants = [];
  for (const p of UNUSED_PATHS) {
    assert.equal(policy.classify(p), "unused-compiled", `JS classify(${p})`);
    variants.push(["extension/" + p, "unused-compiled"], ["./" + p.replace("/", "/"), "unused-compiled"], [p.toUpperCase(), "unused-compiled"], [p.replace(/\//g, "\\"), "unused-compiled"]);
  }
  for (const [input, expected] of variants) assert.equal(policy.classify(input), expected, `JS classify(${input})`);
  const matrix = [...UNUSED_PATHS.map(p => [p, "unused-compiled"]), ...variants];
  const script = `
import json,sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "..", "..", "scripts"))})
import package_content_policy as p
cases=json.loads(sys.stdin.read())
print(json.dumps([p.classify(c[0]) for c in cases]))
`;
  const result = runPython(["-B", "-I", "-c", script], JSON.stringify(matrix));
  assert.equal(result.status, 0, `python unused-compiled matrix failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  matrix.forEach((entry, index) => assert.equal(out[index], entry[1], `python classify(${entry[0]})`));
});

test("unused-compiled 是 exact-path 语义：相邻/前后缀合法名字不误拒（r21 #4）", () => {
  assert.ok(UNUSED_PATHS.length > 0);
  for (const p of UNUSED_PATHS) {
    assert.equal(policy.classify(p + "x.js"), undefined, `sibling ${p}x.js 不得命中`);
    assert.equal(policy.classify(p.replace(/\.js$/, ".json")), undefined, `${p}.json 变体不得命中 unused-compiled`);
  }
  // 代表例：与被排除模块同目录的在册运行件
  for (const kept of ["dist/services/SetupGuideSource.js", "dist/ui/sections/ExtraSection.js", "dist/state/PanelWindowState.js"]) {
    assert.notEqual(policy.classify(kept), "unused-compiled", `${kept} 是邻近合法名，不该被 exact 规则命中`);
  }
});

test(".vscodeignore unused-compiled 标记块与 JSON 单源逐条一致，防两处漂移（r21 #3）", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "..", ".vscodeignore"), "utf8").replace(/\r\n/g, "\n");
  const BEGIN = "# >>> unused-compiled (generated from scripts/package-content-policy.json; consistency enforced by test/features/packageContentPolicy.test.js)";
  const END = "# <<< unused-compiled";
  const begin = text.indexOf(BEGIN); const end = text.indexOf(END);
  assert.equal(begin >= 0, end >= 0, ".vscodeignore 的 unused-compiled 标记块要么成对出现，要么完全不存在");
  if (begin >= 0) assert.ok(end > begin, ".vscodeignore 的 unused-compiled 结束标记必须位于开始标记之后");
  // Mac 适配（本批 087）：Windows 权威要求 .vscodeignore 必带 unused-compiled 标记块，但按 Mac 自身 dist 闭包实测，
  // 排除表 79 项中有 28 项仍被 Mac 其它编译产物 require（例如 dist/extension/index.js 需要 dist/extension/ProviderState.js），
  // 照抄标记块会让 Mac 安装包缺运行件。Mac 侧改为反向防漂移：没有标记块时，凡 Mac 闭包真实 require 的文件一律
  // 不得出现在 .vscodeignore 的排除行里；若将来补上标记块，则仍要求与 JSON 单源逐条同序一致。
  if (begin >= 0 && end > begin) {
    const blockLines = text.slice(begin + BEGIN.length, end).split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.length > 0);
    assert.deepEqual(blockLines, UNUSED_PATHS, "若存在标记块必须与 JSON paths 逐条同序一致");
    return;
  }
  const ignoreLines = new Set(text.split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.length > 0).map(line => policy.normalizePath(line)));
  // Mac 侧没有 Windows 的 unused-compiled 标记块；这里直接核对真实必发清单，
  // 任何必发文件（policy.REQUIRED 与 panel-build-manifest 运行件）都不允许出现在 .vscodeignore 的精确排除行里。
  // 运行闭包本身由 test/features/vsixRuntimeClosure.test.js 调 scripts/verify-vsix-runtime.js 做包含性校验。
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "dist", "panel-build-manifest.json"), "utf8"));
  const mustShip = new Set([...policy.REQUIRED, ...(Array.isArray(manifest.files) ? manifest.files.map(row => row.path) : [])].map(p => policy.normalizePath(p)));
  assert.ok(mustShip.size > 50, "本检查必须覆盖真实必发清单，不允许退化为空断言");
  for (const p of mustShip) assert.ok(!ignoreLines.has(p), "Mac 必发文件 " + p + " 不得被 .vscodeignore 排除");
});

test("排除表与保留闭包不相交：required/动态锚/legacy 运行部件/生成输入/manifest 文件/运行时模板（r21 #2/#4）", () => {
  const set = new Set(UNUSED_PATHS.map(p => policy.normalizePath(p)));
  const kept = [
    ...policy.REQUIRED,
    "dist/extension/index.js", "dist/factories/index.js", "dist/ui/sections/index.js", // KEEP-REVIEW barrels（ServiceFactory tryRequire("../extension") 实证动态命中其一）
    "dist/results/ProjectResultCatalogWorker.js", // new Worker(path.join) 动态
    "dist/extension/legacy.js", "dist/ui/PanelHtml.legacy.js", "dist/features/PanelBuildIdentity.js",
    "dist/extension/Activation.js", "dist/factories/ServiceFactory.js", "dist/api/LocalApiServer.js", "dist/api/LocalApiServer.legacy.js",
    "dist/cli.js", "dist/cli.legacy.js", "dist/runCli.js", "dist/panel.js", "dist/syncState.js", "dist/syncState.legacy.js",
    "dist/clusterAgentRuntime.js", "dist/clusterAgentRuntime.legacy.js", "dist/clusterSchedulerRuntime.js", "dist/clusterSchedulerRuntime.legacy.js",
    "dist/workerProbeRuntime.js", "dist/PptPlotBridge.js", "dist/PptPlotBridge.legacy.js", "scripts/check-static.js",
    "dist/features/Comparison.legacy.js", "dist/features/SmallScale.legacy.js", "dist/features/ResultAnomaly.legacy.js", "dist/features/ExperimentConfigRecovery.legacy.js", "dist/ui/WebviewRenderState.legacy.js",
    ...policy.POLICY.markdown_runtime_allow_files,
  ];
  for (const k of kept) assert.ok(!set.has(policy.normalizePath(k)), `保留项 ${k} 不得进入排除表`);
  const manifestPath = path.join(__dirname, "..", "..", "dist", "panel-build-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const row of manifest.files) assert.ok(!set.has(policy.normalizePath(row.path)), `panel-build-manifest 运行文件 ${row.path} 不得被排除`);
});
