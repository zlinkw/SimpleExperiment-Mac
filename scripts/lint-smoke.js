const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const required = [
  "dist/extension.js",
  "dist/panel.js",
  "package.json",
];

for (const rel of required) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required file: ${rel}`);
  }
}

console.log("[lint-smoke] ok");
