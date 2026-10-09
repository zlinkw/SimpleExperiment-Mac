const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
const extension = readSource("src/extension.ts");
const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
const legacyName = ["Moba", "Xterm"].join("");

test("deprecated tunnel aliases stay outside active compilation and packaging", () => {
  assert.ok(config.exclude.includes("src/tunnel/LegacyTunnelCompat.ts"));
  assert.ok(config.exclude.includes(`src/tunnel/${legacyName}*.ts`));
  assert.doesNotMatch(extension, new RegExp(`${legacyName}|LegacyTunnelCompat`));
  assert.match(ignore, /dist\/tunnel\/\[M\]\[o\]\[b\]\[a\]\[X\]\[t\]\[e\]\[r\]\[m\]\*\.js/);
  assert.match(ignore, /dist\/tunnel\/LegacyTunnelCompat\.js/);
});
