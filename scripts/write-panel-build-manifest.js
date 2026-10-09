const fs = require("node:fs");
const path = require("node:path");
const { collectLocalRuntimeClosure } = require("./runtime-closure");
const { createPanelBuildManifest } = require("./panel-build-manifest");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const entrypoints = [packageJson.main, ...Object.values(packageJson.bin || {})]
  .filter(Boolean)
  .map((entry) => String(entry).replace(/^\.\//, "").replace(/\\/g, "/"));
const spawnCandidates = ["scripts/check-static.js"].filter((file) => fs.existsSync(path.join(root, file)));
const closure = collectLocalRuntimeClosure(root, entrypoints, spawnCandidates);
const requiredFiles = [
  "dist/extension.js",
  "dist/extension/legacy.js",
  "dist/ui/PanelHtml.js",
  "dist/ui/PanelHtml.legacy.js",
  "dist/ui/PanelRecoveryHtml.js",
  "dist/features/PanelBuildIdentity.js",
  "dist/features/PanelLifecycle.js",
  "dist/features/PanelStateDelivery.js",
  "dist/features/PanelStateProgress.js",
];
const closureFiles = new Set(closure.map((item) => item.file));
const missingRequired = requiredFiles.filter((file) => !closureFiles.has(file));
if (missingRequired.length) throw new Error(`Panel build manifest closure is missing required files: ${missingRequired.join(", ")}`);
const { manifest, text: manifestText } = createPanelBuildManifest(packageJson.version, closure.map(({ file }) => ({
  path: file,
  content: fs.readFileSync(path.join(root, file)),
})));
const manifestPath = path.join(root, "dist", "panel-build-manifest.json");
fs.writeFileSync(manifestPath, manifestText, "utf8");
process.stdout.write(`[panel-build-manifest] ${manifest.files.length} runtime files, buildId=${manifest.buildId.slice(0, 12)}\n`);
