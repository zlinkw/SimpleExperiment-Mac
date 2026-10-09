const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("acceptance docs, script, and scenarios are registered", () => {
  for (const file of [
    "docs/acceptance-matrix.md",
    "docs/manual-acceptance-checklist.md",
    "docs/feature-coverage.md",
    "docs/xshell-real-integration-checklist.md",
    "docs/xshell-tunnel-full-feature-acceptance.md",
    "docs/xshell-tunnel-policy.md",
    "scripts/acceptance.js",
    "scenarios/full-workflow-fake-acceptance.json",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.acceptance, "node scripts/acceptance.js");
  const matrix = fs.readFileSync(path.join(root, "docs/acceptance-matrix.md"), "utf8");
  for (const term of ["SSH policy", "Plan management", "Result management", "Comparison", "Quality gate", "Case-level analysis", "Small-scale workflow"]) {
    assert.match(matrix, new RegExp(term));
  }
});

test("acceptance remains file-based with no database dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const forbidden = Object.keys(deps).filter((name) => /sqlite|postgres|mysql|mongodb|typeorm|sequelize|prisma|knex|redis/i.test(name));
  assert.deepEqual(forbidden, []);
});
