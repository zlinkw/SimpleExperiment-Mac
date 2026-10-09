const crypto = require("node:crypto");

function createPanelBuildManifest(version, entries) {
  const files = [...entries]
    .map((entry) => ({
      path: String(entry.path).replace(/\\/g, "/"),
      sha256: crypto.createHash("sha256").update(entry.content).digest("hex"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const normalizedVersion = String(version || "");
  const buildId = crypto.createHash("sha256").update(JSON.stringify({ schemaVersion: 1, version: normalizedVersion, files })).digest("hex");
  const manifest = { schemaVersion: 1, version: normalizedVersion, buildId, files };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = crypto.createHash("sha256").update(text).digest("hex");
  return { manifest, text, manifestHash };
}

module.exports = { createPanelBuildManifest };
