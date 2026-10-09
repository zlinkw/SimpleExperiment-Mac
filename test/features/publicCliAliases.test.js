const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cli = readSource("src/cli.ts");
const legacyNotes = fs.readFileSync(path.join(root, "docs/technical-notes.md"), "utf8");

test("simpleex is the only published command and keeps recorded runs", () => {
  assert.deepEqual(packageJson.bin, { simpleex: "./dist/cli.js" });
  assert.match(cli, /export function runRecordedCli\(argv: string\[\]\): number/);
  assert.match(cli, /if \(require\.main === module\)/);
  assert.match(cli, /Usage: simpleex status/);
  assert.match(legacyNotes, /统一命令 `simpleex run`/);
  assert.match(legacyNotes, /simpleex run --name baseline/);
});
