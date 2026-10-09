const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");

test("shared Windows and Linux worktrees normalize text before Git comparison", () => {
  const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");

  assert.match(attributes, /^\* text=auto(?: eol=lf)?\s*$/m);
});
