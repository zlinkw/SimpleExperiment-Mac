const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ts=require('typescript'),file=require('node:path').resolve(__dirname,'../../scripts/write-agent-runtime.js');
const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='patchVersionHeader');
const scope={};vm.runInNewContext(fn.getText(ast),scope);
test('version injection changes only complete Python constant declarations and leaves protocol regexes intact',()=>{
 const pattern=String.raw`    version = re.search(r'(?m)^RUNTIME_VERSION = "([^\"]+)"', header)`;
 const input=['RUNTIME_VERSION = "0.5.279"','AGENT_VERSION = "0.5.279"',pattern,
   '# PLUGIN_VERSION = "comment"','text = \'SCHEDULER_VERSION = "inside"\''].join('\n');
 const output=scope.patchVersionHeader(input,'0.5.313');
 assert.equal(output,input.replace('RUNTIME_VERSION = "0.5.279"','RUNTIME_VERSION = "0.5.313"').replace('AGENT_VERSION = "0.5.279"','AGENT_VERSION = "0.5.313"'));
 assert.ok(output.includes(pattern));assert.equal(scope.patchVersionHeader(output,'0.5.313'),output);
});
