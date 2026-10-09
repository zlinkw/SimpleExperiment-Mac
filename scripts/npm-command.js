const fs = require("node:fs");
const path = require("node:path");

function npmCommand(args) {
  const npmCli = resolveNpmCli();
  return { command: process.execPath, args: [npmCli, ...(args || [])] };
}

function resolveNpmCli() {
  const executableDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDir, "..", "lib64", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error("Unable to locate npm-cli.js; run this command through npm or install npm beside Node.js.");
  return found;
}

module.exports = { npmCommand, resolveNpmCli };
