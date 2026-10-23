const assert = require('node:assert/strict');
const ts = require('typescript');
const parsed = new Map();

// Extract the exact production method. Adjacent marker strings can move or
// appear inside a method body; neither is a valid JavaScript parse boundary.
module.exports = function legacyMethod(source, marker) {
  const name = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(marker)?.[1];
  assert.ok(name, 'method name required: ' + marker);
  let methods = parsed.get(source);
  if (!methods) {
    const ast = ts.createSourceFile('legacy.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    methods = new Map();
    const visit = node => {
      if (ts.isClassDeclaration(node) && node.name?.text === 'RealtimeTunnelPanelProvider') {
        for (const member of node.members) if (ts.isMethodDeclaration(member)) methods.set(member.name.getText(ast), member.getText(ast));
      } else ts.forEachChild(node, visit);
    };
    visit(ast); parsed.set(source, methods);
  }
  assert.ok(methods.has(name), 'production method missing: ' + name);
  return methods.get(name);
};
