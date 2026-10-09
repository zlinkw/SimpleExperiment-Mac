const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { collectLocalRuntimeClosure } = require("./runtime-closure");
const { createPackageProjection, assertPackageProjection } = require("./mac-package-projection");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const compiledRuntimeVersion = require(path.join(root, "dist/runtime/RuntimeManifest.js")).CURRENT_RUNTIME_VERSION;
if (compiledRuntimeVersion !== packageJson.version) {
  process.stderr.write(`Compiled runtime version ${compiledRuntimeVersion} differs from package ${packageJson.version}.\n`);
  process.exit(1);
}
// Use the lockfile-pinned local tool. Validation must never fetch packages or wait for npm consent.
const vsceCli = require.resolve("@vscode/vsce/vsce");
const projection = createPackageProjection(root);
const result = spawnSync(process.execPath, [vsceCli, "ls", "--no-dependencies"], {
  cwd: projection.directory,
  encoding: "utf8",
  timeout: 8000,
  windowsHide: true,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || `${result.error?.message || "vsce ls failed"}\n`);
  process.exit(result.status || 1);
}
assertPackageProjection(projection);

const packaged = new Set(
  String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, "").replace(/\\/g, "/"))
    .filter((line) => line && !line.startsWith("INFO ") && !line.startsWith("WARNING ")),
);
const entrypoints = [packageJson.main, ...Object.values(packageJson.bin || {})]
  .filter(Boolean)
  .map((entry) => String(entry).replace(/^\.\//, "").replace(/\\/g, "/"));
const missing = [];
// spawn 候选（非 require 直连，经 child_process.spawnSync 运行时加载）：
// src/extension/legacy.ts#runCheckStaticFromUi 双候选归一后命中 scripts/check-static.js，
// 必须随包发布，否则用户侧报“check-static 脚本缺失”。此处断言磁盘存在即必须收录，
// 并纳入 require 闭包队列做传递验证（P0：不硬编码任何端口/IP，只校验路径收录）。
const spawnCandidates = ["scripts/check-static.js"];
for (const candidate of spawnCandidates) {
  const absolute = path.join(root, candidate);
  if (!fs.existsSync(absolute)) continue;
  const normalized = candidate.replace(/\\/g, "/");
  if (!packaged.has(normalized) && !packaged.has(`extension/${normalized}`)) {
    missing.push({ importer: "spawn:src/extension/legacy.ts#runCheckStaticFromUi", required: normalized, chain: ["spawn", normalized] });
  }
}
const closure = collectLocalRuntimeClosure(root, entrypoints, spawnCandidates.filter((candidate) => fs.existsSync(path.join(root, candidate))));
for (const item of closure) {
  const normalized = item.file;
  if (!packaged.has(normalized) && !packaged.has(`extension/${normalized}`)) {
    missing.push({ importer: item.chain.at(-2) || "package.json", required: normalized, chain: item.chain });
  }
}

const buildManifestPath = path.join(root, "dist", "panel-build-manifest.json");
if (!fs.existsSync(buildManifestPath)) {
  missing.push({ importer: "build", required: "dist/panel-build-manifest.json", chain: ["build", "dist/panel-build-manifest.json"] });
} else {
  const manifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf8"));
  for (const row of Array.isArray(manifest.files) ? manifest.files : []) {
    const file = String(row.path || "").replace(/\\/g, "/");
    if (file && !packaged.has(file) && !packaged.has(`extension/${file}`)) {
      missing.push({ importer: "dist/panel-build-manifest.json", required: file, chain: ["dist/panel-build-manifest.json", file] });
    }
  }
}

if (missing.length) {
  process.stderr.write(`VSIX runtime closure missing ${missing.length} file(s):\n`);
  for (const item of missing) process.stderr.write(`- ${item.required} <- ${item.chain.join(" <- ")}\n`);
  process.exit(1);
}

process.stdout.write(`VSIX runtime closure verified: ${closure.length} local module(s), ${entrypoints.length} entrypoint(s).\n`);
