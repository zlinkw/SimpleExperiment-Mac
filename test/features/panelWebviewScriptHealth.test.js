const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

function loadSourceRenderer() {
  const sourcePath = path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(code, sourcePath);
  return loaded.exports.renderPanelHtml;
}

const renderPanelHtml = loadSourceRenderer();

function extractScripts(html) {
  const scripts = [];
  const expression = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = expression.exec(html))) scripts.push(match[1]);
  assert.ok(scripts.length, "script tag missing");
  return scripts;
}

test("panel webview script parses and keeps config commands", () => {
  const html = renderPanelHtml();
  const scripts = extractScripts(html);
  for (let index = 0; index < scripts.length; index += 1) {
    assert.doesNotThrow(() => new vm.Script(scripts[index], { filename: `panel-webview-${index + 1}.js` }));
  }
  const script = scripts.join("\n");
  for (const command of [
    "configureSessions",
    "saveAgentDefaults",
    "saveWorkerConfig",
    "addWorkerConfig",
    "deleteWorkerConfig",
    "saveSchedulerConfig",
    "writeAgentCommands",
    "startAllConnections",
    "testAll",
  ]) {
    assert.match(html, new RegExp(command));
  }
  assert.match(script, /代码版本不匹配/);
  assert.match(script, /status-warning/);
  assert.equal((script.match(/const blockedOnly/g) || []).length, 1);
  assert.match(script, /isParseableResultCandidate/);
  assert.match(script, /jobs\.csv/);
  assert.match(script, /documentGeneration: panelDocumentGeneration/);
  assert.match(script, /renderHealth/);
  assert.match(script, /state-render-frame-stalled/);
  assert.match(script, /required-render-root-missing/);
});

test("training recovery clicks track each job and send a correlated status request", () => {
  const script = extractScripts(renderPanelHtml()).join("\n");
  const parsed = ts.createSourceFile("panel-click.js", script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const names = new Set(["payloadFromButton", "commandNeedsLoading", "createClientActionId",
    "pendingKeyForButton", "pendingKeyForAction", "pendingKeyFromButtonDataset"]);
  const helpers = [];
  let click;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) helpers.push(node.getText(parsed));
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "document.addEventListener"
      && node.arguments[0]?.text === "click" && node.arguments[1]?.getText(parsed).includes("data-distributed-retry"))
      click = node.arguments[1].getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(helpers.length, names.size);
  assert.ok(click, "actual recovery click handler missing");
  const sent = [], loading = [];
  const sandbox = {
    vscode: { postMessage: payload => sent.push(payload) },
    COMMANDS_WITHOUT_LOADING: new Set(), RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS: new Set(), ARTIFACT_SCOPE_COMMANDS: new Set(),
    pendingButtonKeys: new Set(), pendingActions: {}, pendingActionsById: {}, pendingActionTimeouts: {},
    retryableTransferCommand: () => false, planPhaseCommand: () => false, renderCommandPhaseLine() {}, hidePinContextMenu() {},
    setButtonLoading: (button, key) => loading.push({ button, key }), setTimeout: () => 1,
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers.join("\n") + "\nthis.click = " + click + ";", sandbox);
  const button = index => ({ dataset: { distributedRetry: "original-run", jobIndex: String(index), planFile: "plans/train.yaml" },
    textContent: "核验并恢复训练完成", disabled: false, closest: () => null, getAttribute: () => null });
  function press(target) {
    sandbox.click({ preventDefault() {}, stopPropagation() {}, target: { closest(selector) {
      if (selector === "button[data-distributed-retry]") return target;
      if (selector === "button[data-command]" && target.dataset.command) return target;
      return null;
    } } });
  }
  const first = button(0);
  press(first);
  press(first);
  press(button(1));
  assert.equal(sent.length, 2, "deduplicate the same job, retain independent job requests");
  assert.equal(loading.length, 2);
  for (let index = 0; index < sent.length; index++) {
    const payload = sent[index];
    assert.equal(payload.command, "retryDistributedJob");
    assert.equal(payload.planId, "original-run");
    assert.equal(payload.planFile, "plans/train.yaml");
    assert.equal(payload.jobIndex, index);
    assert.ok(payload.clientActionId);
    assert.equal(sandbox.pendingActionsById[payload.clientActionId].jobIndex, index);
    assert.equal(sandbox.pendingKeyFromButtonDataset(loading[index].button), loading[index].key);
  }
  assert.match(loading[0].key, /jobIndex=0/);
  assert.notEqual(loading[0].key, loading[1].key);
});

test("manual single and batch buttons send the selected job identities without a busy-card filter", () => {
  const script = extractScripts(renderPanelHtml()).join("\n");
  const parsed = ts.createSourceFile("manual-click.js", script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let click, change, selection;
  function visit(node) {
    if(ts.isFunctionDeclaration(node)&&node.name?.text==='currentManualJobSelection')selection=node.getText(parsed);
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "document.addEventListener") {
      const body=node.arguments[1]?.getText(parsed)||"";
      if (node.arguments[0]?.text === "click" && body.includes('button[data-manual-dispatch]')) click=body;
      if (node.arguments[0]?.text === "change" && body.includes('input[data-manual-job]')) change=body;
    }
    ts.forEachChild(node,visit);
  }
  visit(parsed);assert.ok(click);assert.ok(change);
  const sent=[],notices=[],sandbox={manualJobSelections:new Map(),hidePinContextMenu(){},vscode:{postMessage:p=>sent.push(p)},
    asArray:v=>Array.isArray(v)?v:[],lastState:{distributedPlans:[{id:'run',jobs:[{index:2,commandId:'old-command',status:'running'}]}]},showToast:m=>notices.push(m)};
  vm.createContext(sandbox);vm.runInContext(selection+';this.click='+click+';this.change='+change,sandbox);
  const single={dataset:{planId:'run',jobIndex:'2',commandId:'old-command'}};
  const event=target=>({preventDefault(){},stopPropagation(){},target:{closest:selector=>selector==='button[data-manual-dispatch]'?target:null}});
  sandbox.click(event(single));
  assert.equal(JSON.stringify(sent[0]),JSON.stringify({command:'dispatchJobs',planId:'run',indices:[2],expectedCommands:{2:'old-command'}}));
  sandbox.lastState.distributedPlans[0].jobs=[{index:2,commandId:'c2',status:'unknown'},{index:5,commandId:'c5',status:'running'}];
  for(const i of [2,5])sandbox.change({target:{closest:()=>({checked:true,dataset:{planId:'run',manualJob:String(i),commandId:'c'+i}})}});
  sandbox.click(event({dataset:{planId:'run'}}));
  assert.equal(JSON.stringify(sent[1].indices),'[2,5]');assert.equal(sent[1].expectedCommands[5],'c5');
  sandbox.lastState.distributedPlans[0].jobs[0].commandId='new-command';
  sandbox.click(event({dataset:{planId:'run'}}));assert.equal(sent.length,2);assert.match(notices[0],/无需重新运行 PLAN/);
  assert.equal(sandbox.manualJobSelections.get('run').has(2),false);
});
test("Agent defaults stay in the normal editable server configuration flow",()=>{
 const script=extractScripts(renderPanelHtml()).join('\n'),tree=ts.createSourceFile('defaults.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let scope;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='isServerConfigScope')scope=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);
 const isServerScope=vm.runInNewContext(scope+';isServerConfigScope;');
 assert.equal(isServerScope('defaults'),true);assert.equal(isServerScope('worker:a'),true);assert.equal(isServerScope('hub'),false);
 assert.match(script,/delete configDrafts\.defaults/);
});
test('an unassigned job renders an empty command identity all the way into the actual click payload',()=>{
 const script=extractScripts(renderPanelHtml()).join('\n');
 const line=script.split('\n').find(s=>s.includes('const manualControls=status'));
 const esc=value=>String(value===undefined||value===null||value===''?'-':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 const html=vm.runInNewContext(line+';manualControls',{status:'pending',job:{index:5},manualPlan:'p',manualSelection:new Map(),escAttr:esc});
 const commands=[...html.matchAll(/data-command-id="([^"]*)"/g)].map(m=>m[1]);
 assert.deepEqual(commands,['','']);
});
