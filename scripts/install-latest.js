"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runInstallLatest } = require("./install-latest-policy");

function runCodeCli(args, options = {}) {
  if (process.platform === "win32") {
    const command = ["code", ...args.map((argument) => {
      const value = String(argument);
      return /[\s&|<>]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })].join(" ");
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { windowsHide: true, ...options });
  }
  return execFileSync("code", args, { windowsHide: true, ...options });
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const vsix = path.join(__dirname, `../simple-experiment-${pkg.version}.vsix`);
  if (!dryRun && !fs.existsSync(vsix)) throw new Error(`VSIX not found: ${vsix}`);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const lockPath = path.join(tempRoot, "simple-experiment-install.lock");
  if (path.dirname(path.resolve(lockPath)) !== tempRoot) throw new Error("Install lock path is outside the verified system temporary directory.");
  const outcome = await runInstallLatest({
    targetVersion: pkg.version,
    extensionId: `${pkg.publisher}.${pkg.name}`,
    vsixPath: vsix,
    lockPath,
    dryRun,
    listExtensions: () => runCodeCli(["--list-extensions", "--show-versions"], { encoding: "utf8" }),
    install: (file) => runCodeCli(["--install-extension", file], { stdio: "inherit" }),
  });
  if (outcome.status === "dry-run") console.log(JSON.stringify({ installed: outcome.installedVersion || "", target: outcome.targetVersion, decision: outcome.decision, vsixPath: outcome.vsixPath }, null, 2));
  else if (outcome.status === "skip") console.log(`${outcome.version} 已安装，跳过重复安装。`);
  else console.log(`[install-latest] installed ${outcome.version} successfully`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[install-latest] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, runCodeCli };
