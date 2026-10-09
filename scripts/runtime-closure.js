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
    const relative = String(item.file).replace(/\\/g, "/");
    if (visited.has(relative)) continue;
    visited.set(relative, item.chain);
    const absolute = path.join(root, relative);
    if (path.extname(absolute) !== ".js") continue;
    let source;
    try { source = fsApi.readFileSync(absolute, "utf8"); } catch { continue; }
    const requires = [...source.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]);
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
