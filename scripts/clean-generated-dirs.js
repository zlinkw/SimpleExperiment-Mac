const fs = require("fs");
const path = require("path");

const TARGET_NAMES = new Set(["__pycache__", "simple_agent", "simple_cluster"]);

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function collectCleanupTargets(rootDir) {
  const root = fs.realpathSync(rootDir);
  const targets = [];

  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      let real = full;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!isInside(root, real)) {
        continue;
      }
      if (TARGET_NAMES.has(entry.name)) {
        targets.push(real);
        continue;
      }
      visit(real);
    }
  }

  visit(root);
  return Array.from(new Set(targets)).sort((a, b) => b.length - a.length);
}

function cleanGeneratedDirs(options = {}) {
  const root = fs.realpathSync(options.rootDir || process.cwd());
  const dryRun = Boolean(options.dryRun);
  const targets = collectCleanupTargets(root);

  for (const target of targets) {
    if (!isInside(root, target)) {
      throw new Error(`Unsafe cleanup target: ${target}`);
    }
    if (!dryRun) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  return { root, dryRun, targets };
}

function parseArgs(argv) {
  const args = { dryRun: false, rootDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--root") {
      args.rootDir = argv[++i];
    }
  }
  return args;
}

if (require.main === module) {
  const result = cleanGeneratedDirs(parseArgs(process.argv.slice(2)));
  const mode = result.dryRun ? "would clean" : "cleaned";
  console.log(`[cleanup] ${mode} ${result.targets.length} dirs`);
  for (const target of result.targets) {
    console.log(target);
  }
}

module.exports = {
  TARGET_NAMES,
  cleanGeneratedDirs,
  collectCleanupTargets,
  isInside,
};
