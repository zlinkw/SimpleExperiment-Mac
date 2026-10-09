const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const acceptance = fs.readFileSync(path.join(root, "scripts/acceptance.js"), "utf8");

test("release acceptance command has an executable report workflow", () => {
  assert.equal(packageJson.scripts.acceptance, "node scripts/acceptance.js");
  assert.match(acceptance, /runNpm\("build", \["run", "build"\]\)/);
  assert.match(acceptance, /runNpm\("unit tests", \["test"\]\)/);
  assert.equal(packageJson.scripts["test:scenarios"], "npm run test:features");
  assert.match(acceptance, /runNpm\("feature regression tests", \["run", "test:features"\]\)/);
  assert.doesNotMatch(acceptance, /shell\s*:/);
  assert.match(acceptance, /overall=\$\{overall\}/);
  assert.match(acceptance, /path\.join\(root, "simple_cluster", "reports", "acceptance"\)/);
});
