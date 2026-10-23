const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

const panelFunction=require('../_helpers/panelFunction');
const vm=require('node:vm');
test("rendered topology uses enabled Workers and never creates a Hub hop",()=>{
  let html;
  const scope={EMPTY_WORKER_TUNNELS_FOR_ALIAS:[],enabledWorkerTunnelsCacheSource:null,enabledWorkerTunnelsCacheValue:[],
    esc:value=>String(value),setHtmlIfChanged:(id,value)=>{assert.equal(id,'serverTopologyMap');html=value;}};
  vm.runInNewContext(panelFunction('enabledWorkerTunnelsForState')+'\n'+panelFunction('renderServerTopologyMap')+'\nthis.render=renderServerTopologyMap;',scope);
  scope.render({topology:{mode:'hub_worker'},setup:{hubHost:'historical',workerTunnels:[{id:'a',enabled:true},{id:'b',enabled:false}]}});
  assert.match(html,/Worker 模式/);assert.match(html,/本机插件 → 1 台 Worker → 各自的任务窗口与产物/);assert.doesNotMatch(html,/Hub|historical/);
});
