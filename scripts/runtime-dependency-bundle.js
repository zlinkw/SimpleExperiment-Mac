"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
function embedRuntimeDependencies(text, root = path.resolve(__dirname, "..")) {
  const folder = path.join(root, "vendor/python"), lock = JSON.parse(fs.readFileSync(path.join(folder, "dependencies.lock.json"), "utf8"));
  if (lock.name !== "PyYAML" || lock.version !== "6.0.3" || lock.bundle !== "PyYAML-6.0.3.zip" || lock.license !== "MIT") throw new Error("Unexpected Agent dependency lock");
  const bytes = fs.readFileSync(path.join(folder, lock.bundle));
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== lock.bundleSha256) throw new Error("Agent PyYAML bundle differs from dependency lock");
  if (!text.includes('"__SIMPLE_PYYAML_BASE64__"') || !text.includes('"__SIMPLE_PYYAML_SHA256__"')) throw new Error("Runtime dependency producer is missing");
  return text.replace('"__SIMPLE_PYYAML_BASE64__"', JSON.stringify(bytes.toString("base64"))).replace('"__SIMPLE_PYYAML_SHA256__"', JSON.stringify(lock.bundleSha256));
}
module.exports = { embedRuntimeDependencies };
