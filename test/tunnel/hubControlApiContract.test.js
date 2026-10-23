const test = require("node:test");
const assert = require("node:assert/strict");

const { hubControlRequiredEndpoints, isHubOnlyApiPath, isHubControlAction } = require("../../dist/tunnel/HubControlApi.js");

test("compatibility Hub exports cannot declare or authorize current control endpoints",()=>{
  assert.deepEqual(hubControlRequiredEndpoints,[]);
  for(const action of ['delete-artifacts','run-plan','validate-plan','start-worker-task'])assert.equal(isHubControlAction(action),false);
  for(const url of ['/api/actions/run-plan','/api/files/download'])assert.equal(isHubOnlyApiPath(url),true,'retired Hub routes remain recognizable for explicit rejection');
  assert.equal(isHubOnlyApiPath('/api/worker/tasks'),false);
});
