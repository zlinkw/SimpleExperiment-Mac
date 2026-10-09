const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(execFile) {
  const source = fs.readFileSync(require.resolve('../../src/features/ProjectStaticCheck.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, process, require: () => ({ execFile }) });
  return exports.runProjectStaticCheck;
}

test('check runs asynchronously, captures bounded output, and accepts a report with findings', async () => {
  let callback;
  const run = load((executable, args, options, cb) => {
    assert.equal(executable, process.execPath);
    assert.ok(args.includes('--json'));
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    callback = cb;
  });
  let finished=false;
  const pending = run('check.js', '/project').then(value => { finished=true; return value; });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false, 'Host event loop remains available while check runs');
  callback({code:1}, JSON.stringify({reportWritten:true,overall:'failed',summary:{plans:3}}), '');
  assert.equal((await pending).plans,3);
});

test('process failure, abort, and missing new report cannot present old report as success', async () => {
  for (const [error, stdout] of [
    [{code:null,killed:true,message:'timeout'},''],
    [{code:'ABORT_ERR',message:'aborted'},''],
    [null, JSON.stringify({reportWritten:false,overall:'passed'})],
  ]) {
    const run = load((_exe,_args,_opts,cb)=>cb(error,stdout,''));
    await assert.rejects(run('check.js','/project'));
  }
});

test('UI check shares one process and releases transient state after failure', async () => {
  const source=fs.readFileSync(require.resolve('../../src/extension/legacy.ts'),'utf8');
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='RealtimeTunnelPanelProvider');
  const method=cls.members.find(n=>n.name?.getText(ast)==='runCheckStaticFromUi').getText(ast);
  const Provider=vm.runInNewContext(ts.transpileModule(`class Provider {${method}};Provider`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{AbortController});
  const p=new Provider();let calls=0;let reject;
  p.runCheckStaticCore=()=>{calls++;return new Promise((_resolve,fail)=>reject=fail);};
  const one=p.runCheckStaticFromUi(), two=p.runCheckStaticFromUi();
  assert.equal(calls,1); reject(new Error('test failure'));
  await Promise.all([assert.rejects(one),assert.rejects(two)]);
  assert.equal(p.projectStaticCheckPromise,undefined);
  assert.equal(p.projectStaticCheckAbort,undefined);
  const core=cls.members.find(n=>n.name?.getText(ast)==='runCheckStaticCore').getText(ast);
  assert.doesNotMatch(core,/spawnSync|unlink|rm\(/);
  assert.match(core,/workspaceRoot\(\) !== root/);
});
