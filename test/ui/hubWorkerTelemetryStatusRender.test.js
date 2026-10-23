const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {renderPanelHtml}=require('../../dist/ui/PanelHtml');
const panelFunction=require('../_helpers/panelFunction');
test('the rendered panel offers Worker telemetry without a retired Hub control surface',()=>{
  const html=renderPanelHtml();
  assert.match(html,/id="workerTelemetryStatus"/);assert.match(html,/data-command="startWorker"/);
  assert.doesNotMatch(html,/id="hubControlStatus"|data-command="startHub"/);
  const writes=new Map(),sandbox={setHtmlIfChanged:(key,value)=>writes.set(key,value),configurationSourceCards:()=>'',
    DIAGNOSTIC_WORKER_CARD_LIMIT:4,DIAGNOSTIC_PORT_ASSIGNMENT_LIMIT:4,DIAGNOSTIC_PORT_CONFLICT_LIMIT:4,
    workerTelemetryCard:row=>'worker:'+row.workerId,diagnosticBudgetedCardGrid:(rows,limit,render)=>rows.slice(0,limit).map(render).join(',')};
  vm.runInNewContext(panelFunction('renderWorkerAndPorts')+';this.render=renderWorkerAndPorts;',sandbox);
  sandbox.render({hubControlStatus:{id:'retired-hub'},workerTelemetryStatus:[{workerId:'current-worker'}]});
  assert.match(writes.get('workerTelemetryStatus'),/current-worker/);
  assert.equal(writes.has('hubControlStatus'),false);assert.doesNotMatch([...writes.values()].join(''),/retired-hub/);
});
