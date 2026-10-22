const assert = require('node:assert/strict');
const ts = require('typescript');
const { renderPanelHtml } = require('../../dist/ui/PanelHtml.legacy');

// Read the shipped script after template interpolation and escaping.
function panelPrelude(platform = 'win32') {
  const html = renderPanelHtml(platform), wanted = new Set([
    'MAC_PLAN_IDENTITY', 'OUTCOME_PENDING_HISTORY_TYPES', 'OUTCOME_PENDING_ACTIVE_TOKENS', 'operationOutcomePendingHistory', 'manualJobSelections',
  ]), found = new Map();
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const ast = ts.createSourceFile('rendered-panel.js', match[1], ts.ScriptTarget.Latest, true);
    (function visit(node) {
      if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) found.set(node.name.text, node.getText(ast));
      if (ts.isVariableDeclaration(node) && wanted.has(node.name.getText(ast))) found.set(node.name.getText(ast), 'const ' + node.getText(ast) + ';');
      ts.forEachChild(node, visit);
    })(ast);
  }
  for (const name of wanted) assert.ok(found.has(name), 'rendered dependency: ' + name);
  return [...wanted].map(name => found.get(name)).join('\n') + '\n';
}

module.exports = { panelPrelude };
