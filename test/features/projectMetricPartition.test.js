const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function trackedMetrics(values) {
  let iterations = 0;
  return {
    values: {
      [Symbol.iterator]() {
        iterations += 1;
        return values[Symbol.iterator]();
      },
    },
    iterations: () => iterations,
  };
}

test("project metrics split classification and segmentation in one traversal", () => {
  const sandbox = { SEGMENTATION_PROJECT_METRIC_PATTERN: /dice|dsc|iou|hd95|asd|hausdorff/i };
  vm.createContext(sandbox);
  const source = extractFunction("partitionProjectMetrics");
  assert.doesNotMatch(source, /normalizedMetrics\.(?:filter|map)\(/);
  vm.runInContext(`${source}\nthis.partition = partitionProjectMetrics;`, sandbox);
  const metrics = trackedMetrics(["AUC", "Dice", "mean_IoU", "HD95", "specificity", "hausdorff95", "ASD_score", "DSC"]);
  const groups = sandbox.partition(metrics.values);

  assert.equal(metrics.iterations(), 1);
  assert.deepEqual(Array.from(groups.classification), ["AUC", "specificity"]);
  assert.deepEqual(Array.from(groups.segmentation), ["Dice", "mean_IoU", "HD95", "hausdorff95", "ASD_score", "DSC"]);
});

test("project adapter inference consumes partitioned metrics before default completion", () => {
  const source = extractFunction("inferProjectAdapterRules");
  assert.match(source, /const metricGroups = partitionProjectMetrics\(normalizedMetrics\)/);
  assert.match(source, /\.\.\.metricGroups\.classification/);
  assert.match(source, /\.\.\.metricGroups\.segmentation/);
  assert.doesNotMatch(source, /normalizedMetrics\.filter\(/);
  for (const metric of ["AUC", "accuracy", "F1", "Dice", "DSC", "IoU", "HD95", "ASD"]) {
    assert.match(source, new RegExp(`"${metric}"`), metric);
  }
});
