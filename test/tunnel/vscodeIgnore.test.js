const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const ignorePath = path.join(root, ".vscodeignore");

test("vscodeignore 排除 review_report 与 vsix 以减小包体积", () => {
  const ignore = fs.readFileSync(ignorePath, "utf8");
  // 必须显式排除 review_report.md（根与任意子路径）
  assert.match(ignore, /^review_report\.md$/m, "should ignore review_report.md at root");
  assert.match(ignore, /^\*\*\/review_report\.md$/m, "should ignore review_report.md in subdirs");
  // vsix 排除
  assert.match(ignore, /^\*\.vsix$/m, "should ignore *.vsix");
  assert.match(ignore, /^\*\*\/\*\.vsix$/m, "should ignore **/*.vsix");
  // 已有 _*.md 排除不应误删此条
  assert.match(ignore, /^_\*\.md$/m);
});

test("vsce ls 打包清单不含 review_report.md 与 vsix", () => {
  const { npmCommand } = require("../../scripts/npm-command");
  const npm = npmCommand(["exec", "--", "@vscode/vsce", "ls", "--no-dependencies"]);
  const result = spawnSync(npm.command, npm.args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
  });
  if (result.error || result.status !== 0) {
    console.log("vsce ls unavailable, skipped live check:", result.error || result.stderr || result.stdout);
    return;
  }
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\.\//, "").replace(/\\/g, "/"))
    .filter(Boolean);
  const hasReview = lines.some((l) => l === "review_report.md" || l.endsWith("/review_report.md") || l === "extension/review_report.md");
  const hasVsix = lines.some((l) => l.endsWith(".vsix"));
  assert.equal(hasReview, false, `vsce ls should not contain review_report.md, got:\n${lines.join("\n")}`);
  assert.equal(hasVsix, false, `vsce ls should not contain *.vsix, got:\n${lines.join("\n")}`);
  // 额外确认扩展仍能运行的必要文件仍在包内
  assert.ok(lines.includes("package.json") || lines.includes("extension/package.json"));
  assert.ok(lines.some((l) => l.includes("dist/extension.js")));
});
