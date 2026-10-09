const fs = require("node:fs");
const path = require("node:path");
const { collectLocalRuntimeClosure } = require("./runtime-closure");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const installed = require("semver/package.json");
if (manifest.dependencies?.semver !== installed.version) throw new Error("SemVer dependency must match the explicitly pinned package version.");
const dependencyRoot = path.dirname(require.resolve("semver/package.json"));
const destination = path.join(root, "dist/vendor/semver");
const closure = collectLocalRuntimeClosure(dependencyRoot, ["functions/compare.js", "functions/valid.js", "functions/satisfies.js", "ranges/valid.js"]);
let bytes = 0;
for (const { file } of closure) {
  const source = fs.readFileSync(path.join(dependencyRoot, file), "utf8");
  for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!match[1].startsWith(".")) throw new Error(`SemVer runtime has an unbundled external dependency: ${match[1]}`);
  }
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, "utf8");
  bytes += Buffer.byteLength(source);
}
fs.writeFileSync(path.join(destination, "LICENSE"), fs.readFileSync(path.join(dependencyRoot, "LICENSE"), "utf8"), "utf8");
fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name: installed.name, version: installed.version, license: installed.license }, null, 2) + "\n", "utf8");
process.stdout.write(`[semver] ${installed.version}, ${closure.length} runtime files, ${bytes} bytes\n`);
