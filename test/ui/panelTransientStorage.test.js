const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../src/ui/PanelHtml.legacy.ts'),'utf8');
function functions(names){return names.map(name=>{const start=source.indexOf(`    function ${name}(`);const end=source.indexOf('\n    function ',start+1);return source.slice(start,end);}).join('\n');}

test('unavailable VS Code state storage cannot abort bootstrap or subsequent render ACK',()=>{
  const vscode={getState(){throw new Error('storage unavailable');},setState(){throw new Error('write failed');}};
  const c=vm.createContext({vscode});
  vm.runInContext(functions(['readStoredWebviewState','persistWebviewState']),c);
  assert.equal(Object.keys(c.readStoredWebviewState(vscode)).length,0);
  assert.equal(c.persistWebviewState({selectedPlanFile:'plan.yaml'}),false);
  let ack=false;assert.doesNotThrow(()=>{c.persistWebviewState({});ack=true;});assert.equal(ack,true);
  assert.match(source,/const restoredWebviewState = readStoredWebviewState\(vscode\)/);
});

test('long-session expansion history is bounded while unsaved config drafts are retained',()=>{
  const c=vm.createContext({});vm.runInContext(functions(['normalizeStoredPanelMap']),c);
  const history=Object.fromEntries(Array.from({length:10000},(_,i)=>['task-'+i,true]));
  const compact=c.normalizeStoredPanelMap(history);
  assert.equal(Object.keys(compact).length,256);assert.equal(compact['task-9999'],true);
  const drafts={server:{command:'x'.repeat(10000)},project:{config:'未保存的配置'}};
  assert.equal(c.normalizeStoredPanelMap(drafts,true).server.command,drafts.server.command);
  assert.equal(c.normalizeStoredPanelMap(drafts,true).project.config,drafts.project.config);
  const hostile=JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(Object.keys(c.normalizeStoredPanelMap(hostile,true)).length,0);
});
