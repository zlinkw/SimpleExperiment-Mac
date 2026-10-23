const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');

test('cold runtime generation creates checksums without an ignored template directory', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-runtime-cold-'));
  for (const relative of ['scripts', 'src/runtime', 'dist']) fs.mkdirSync(path.join(fixture, relative), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/write-agent-runtime.js'), path.join(fixture, 'scripts/write-agent-runtime.js'));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '0.5.316' }), 'utf8');
  fs.writeFileSync(path.join(fixture, 'src/runtime/RuntimeManifest.ts'), 'export const CURRENT_RUNTIME_VERSION = "0.5.315";\n', 'utf8');
  for (const [file, symbol, prefix] of [
    ['clusterAgentRuntime', 'CLUSTER_AGENT_RUNTIME', '#!/usr/bin/env python3\nfrom __future__ import annotations\n'],
    ['clusterSchedulerRuntime', 'CLUSTER_SCHEDULER_RUNTIME', 'from __future__ import annotations\n'],
  ]) fs.writeFileSync(path.join(fixture, 'dist', file + '.js'), 'exports.' + symbol + ' = ' + JSON.stringify(prefix + 'RUNTIME_VERSION = "0.5.315"\n'), 'utf8');
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/write-agent-runtime.js')], { cwd: fixture, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  run();
  const manifest = fs.readFileSync(path.join(fixture, 'dist/runtime/RuntimeManifest.json'), 'utf8');
  for (const file of ['cluster_agent.py', 'cluster_scheduler.py']) {
    const bytes = fs.readFileSync(path.join(fixture, 'dist/runtime', file));
    assert.match(bytes.toString('utf8'), /RUNTIME_VERSION = "0\.5\.316"/);
    assert.equal(fs.readFileSync(path.join(fixture, 'dist/runtime', file + '.sha256'), 'utf8'), crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + file + '\n');
  }
  run();
  assert.equal(fs.readFileSync(path.join(fixture, 'dist/runtime/RuntimeManifest.json'), 'utf8'), manifest);
  assert.equal(fs.existsSync(path.join(fixture, 'dist/templates/project-adapter')), false);
  console.log('Retained cold-build fixture: ' + fixture);
});

test('runtime template loading needs no packaged documentation and preserves code templates', async () => {
  const source = fs.readFileSync(path.join(root, 'src/extension/legacy.ts'), 'utf8');
  const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  let method;
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'loadProjectAdapterTemplateFiles') method = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(method);
  const producer = require('../../dist/templates/ProjectAdapterTemplates');
  const scope = { ProjectAdapterTemplates_1: producer, fs: { readFile: () => { throw Error('disk template read'); } } };
  vm.runInNewContext(ts.transpileModule('class Subject { ' + method + ' } this.Subject = Subject;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope);
  const projectName = '项目 A ', actual = await new scope.Subject().loadProjectAdapterTemplateFiles(projectName);
  const expected = producer.projectAdapterTemplateFiles(projectName);
  assert.equal(actual.length, expected.length);
  for (const file of actual) {
    if (!/\.md$/i.test(file.relativePath)) assert.equal(file.text, expected.find(item => item.relativePath === file.relativePath).text);
    else { assert.ok(file.text.length < 300); assert.match(file.text, /needs experiment|https:\/\/github\.com\/zlinkw\/SimpleExperiment-Mac/); }
  }
});
