const test = require('node:test');
const assert = require('node:assert/strict');
require('../_helpers/registerTsRequire');
const R = require('../../src/features/FailedJobRecovery.ts');
function host(policy) {
  const queue = {schemaVersion:1,plans:[{id:'workflow',resultPathPolicy:policy}]}, actions=[];
  const context={root:'/Users/researcher/Projects/项目'};
  return {queue,actions,captureProjectContext:()=>context,projectContextIsCurrent:c=>c===context,
    loadDistributedQueue:async()=>queue,retryDistributedJobFromUi:async m=>{actions.push(m);return {status:'review_required'};}};
}
test('declared formal jobs reuse the explicit retry entry and exact request without creating a new attempt',async()=>{
  const h=host('declared'),before=structuredClone(h.queue),message={planId:'workflow',jobIndex:2,commandId:'exact-command'};
  assert.deepEqual(await R.recallFailedJobFromUi(h,message,()=>assert.fail('no legacy confirmation'),()=>assert.fail('no new attempt')),{status:'review_required'});
  assert.deepEqual(h.actions,[message]);assert.deepEqual(h.queue,before);
});
test('historical attempts remain read-only and pending cleanup obligations never run automatically',async()=>{
  const h=host(undefined);h.queue.failedAttemptRecoveries=[{id:'old',status:'pending',absolutePath:'/srv/project/old'}];
  const before=structuredClone(h.queue);
  await assert.rejects(R.recallFailedJobFromUi(h,{planId:'workflow'},()=>assert.fail('no cleanup confirmation'),()=>assert.fail('no IDs')),/HISTORICAL_ATTEMPT_READ_ONLY/);
  assert.deepEqual(await R.processFailedAttemptRecoveries(h,'/Users/researcher/Projects/项目',()=>assert.fail('no IDs')),{status:'manual_review_required',automaticExecution:false});
  assert.deepEqual(h.queue,before);assert.equal(h.actions.length,0);
});
test('a changed project context cannot forward a formal retry',async()=>{
  const h=host('declared');h.projectContextIsCurrent=()=>false;
  await assert.rejects(R.recallFailedJobFromUi(h,{planId:'workflow'},()=>true,()=>''),/context changed/);
  assert.equal(h.actions.length,0);
});
