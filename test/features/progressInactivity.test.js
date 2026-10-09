const test = require('node:test');
const assert = require('node:assert/strict');
const { ProgressInactivity } = require('../../dist/core/ProgressInactivity');

test('continued real progress outlives old overall limits; phase counters are independent', () => {
  let now=0, failures=0;
  const wait = new ProgressInactivity(120,()=>failures++,()=>now);
  for(let i=1;i<=20;i++){ now+=100; wait.update({phase:'hashing',processedBytes:i*1000}); assert.equal(wait.check(),false); }
  now+=100; wait.update({phase:'transferring',processedBytes:1});
  now+=100; wait.update({phase:'transferring',processedBytes:2});
  assert.equal(wait.check(),false); assert.equal(failures,0); wait.dispose();
});
test('heartbeat, duplicate counters and repeated phases cannot conceal a stall',()=>{
  let now=0, failures=0;
  const wait=new ProgressInactivity(30,()=>failures++,()=>now);
  wait.update({phase:'running',processedFiles:1});
  now=20; assert.equal(wait.update({phase:'running',processedFiles:1}),false);
  now=31; assert.equal(wait.check(),true); assert.equal(failures,1);
  assert.equal(wait.update({processedFiles:2}),false);
});
test('confirmation pauses business time; cancelled waits ignore late results',()=>{
  let now=0, failures=0;
  const wait=new ProgressInactivity(30,()=>failures++,()=>now);
  now=10; wait.pause(); now=1000; assert.equal(wait.check(),false);
  wait.resume(); now=1019; assert.equal(wait.check(),false);
  wait.dispose(); now=5000; assert.equal(wait.update({status:'completed'}),false);
  assert.equal(wait.check(),false); assert.equal(failures,0);
});
