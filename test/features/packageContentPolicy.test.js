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
