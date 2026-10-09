const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("./_helpers/sourceReader");

const sourceRoot = path.join(__dirname, "..", "src");
const compilerOutputPattern = /var __createBinding|Object\.defineProperty\(exports|^exports\./m;

function typescriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

test("the complete TypeScript source tree contains no copied compiler output", () => {
  const files = typescriptFiles(sourceRoot);
  assert.ok(files.length > 100, "expected the complete recovered TypeScript source tree");
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, compilerOutputPattern, path.relative(sourceRoot, file));
  }
});

test("recovered feature and template sources remain TypeScript modules", () => {
  const files = [
    ["extension.ts", ["import * as vscode from \"vscode\";", "export function activate", "export function deactivate"]],
    ["features/PlanArchive.ts", ["export function planStaticConfigReferences", "export function restorePlanText"]],
    ["features/PlottingContract.ts", ["export const PLOTTING_CONTRACT_JSON_PATH", "export function buildPlottingOutputContract"]],
    ["features/PlanBuilder.ts", ["import { createHash } from \"crypto\";", "export const PLAN_REGISTRY_PATH", "export function buildExperimentMatrix"]],
    ["templates/ProjectAdapterTemplates.ts", ["import * as Quality_1", "export function projectAdapterTemplateFiles"]],
  ];

  for (const [relativePath, markers] of files) {
    const source = readSource(`src/${relativePath}`);
    assert.doesNotMatch(source, compilerOutputPattern, relativePath);
    for (const marker of markers) {
      assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${relativePath}: ${marker}`);
    }
  }
});
