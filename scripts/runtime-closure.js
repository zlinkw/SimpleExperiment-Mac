const fs = require("node:fs");
const path = require("node:path");

function resolveLocalModule(directory, specifier, fsApi = fs) {
  const base = path.resolve(directory, specifier);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")];
  return candidates.find((candidate) => {
    try { return fsApi.statSync(candidate).isFile(); } catch { return false; }
  });
}

function collectLocalRuntimeClosure(root, entrypoints, spawnCandidates = [], fsApi = fs) {
  const queue = [...entrypoints.map((file) => ({ file, chain: [file] })), ...spawnCandidates.map((file) => ({ file, chain: ["spawn", file] }))];
  const visited = new Map();
  while (queue.length) {
    const item = queue.shift();
    const relative = String(item.file).replace(/\\/g, "/").replace(/^\.\//, "");
    if (visited.has(relative)) continue;
    visited.set(relative, item.chain);
    const absolute = path.join(root, relative);
    if (path.extname(absolute) !== ".js") continue;
    let source;
    try { source = fsApi.readFileSync(absolute, "utf8"); } catch { continue; }
    // These are the actual lazy wrappers used by the compiled factories. Never
    // execute a module to discover its dependencies.
    const requires = [...source.matchAll(/\b(?:require(?:\.resolve)?|tryRequire)\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]);
    if (/tryRequire\(`\.\.\/\$\{hint\}`\)/.test(source)) {
      const hints = /\b(?:const|let|var) featureImplHints\s*=\s*\{([^}]+)\}/.exec(source);
      if (!hints) throw new Error("Dynamic feature factory hints cannot be resolved");
      for (const match of hints[1].matchAll(/\b\w+\s*:\s*["']([A-Za-z0-9_./-]+)["']/g)) requires.push("../" + match[1]);
    }
    // The catalog is a separate Node worker entrypoint, not a require edge.
    for (const match of source.matchAll(/\bnew\s+[\w$.]*Worker\s*\(\s*[\w$.]*join\s*\(\s*__dirname\s*((?:,\s*["'][^"']+["']\s*)+)\)\s*\)/g)) {
      const pieces = [...match[1].matchAll(/["']([^"']+)["']/g)].map(row => row[1]);
      requires.push(path.join(...pieces));
    }
    for (const specifier of requires) {
      const resolved = resolveLocalModule(path.dirname(absolute), specifier, fsApi);
      if (!resolved) continue;
      const child = path.relative(root, resolved).replace(/\\/g, "/");
      queue.push({ file: child, chain: [...item.chain, child] });
    }
  }
  return [...visited.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, chain]) => ({ file, chain }));
}

module.exports = { collectLocalRuntimeClosure, resolveLocalModule };
