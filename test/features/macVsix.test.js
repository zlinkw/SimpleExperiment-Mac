const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { crc32, inspectVsix, verifyVsix } = require("../../dist/mac/Vsix");

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), body = Buffer.from(text);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt32LE(crc32(body), 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(body.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, body); central.push(directory, filename); offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(platform = "darwin-arm64", name = "simple-experiment-mac") {
  const pkg = { publisher: "simple-local", name, version: "0.1.2", engines: { vscode: "^1.100.0" } };
  return zip({ "extension/package.json": JSON.stringify(pkg), "extension.vsixmanifest": `<Identity Publisher="simple-local" Id="${name}" Version="0.1.2" TargetPlatform="${platform}"/>`, "extension/main.js": "module.exports = {};" });
}
function component(bytes) { return { extensionId: "simple-local.simple-experiment-mac", version: "0.1.2", targetPlatform: "darwin-arm64", vscodeEngine: "^1.100.0", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
test("verifies real XML platform and package identity without package metadata", () => {
  const bytes = fixture(); assert.equal(verifyVsix(bytes, component(bytes), "1.100.0").targetPlatform, "darwin-arm64");
});
test("rejects Windows, universal, foreign identity, incompatible engines and mismatching hashes", () => {
  for (const platform of ["win32-arm64", "universal"]) { const bytes = fixture(platform); assert.throws(() => verifyVsix(bytes, component(bytes), "1.100.0")); }
  const other = fixture("darwin-arm64", "simple-experiment"); assert.throws(() => verifyVsix(other, component(other)));
  const bytes = fixture(); assert.throws(() => verifyVsix(bytes, component(bytes), "1.99.0")); assert.throws(() => verifyVsix(bytes, { ...component(bytes), sha256: "0".repeat(64) }));
});
test("checks every runtime entry CRC and rejects ZIP traversal", () => {
  const bytes = fixture(), broken = Buffer.from(bytes); broken[bytes.indexOf("module.exports")] ^= 1;
  assert.throws(() => inspectVsix(broken), /CRC/);
  assert.throws(() => inspectVsix(zip({ "../escape": "bad" })), /路径/);
});
module.exports = { zip, fixture, component };
