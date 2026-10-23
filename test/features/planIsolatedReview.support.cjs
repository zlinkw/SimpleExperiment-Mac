const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

const {world}=require('../_helpers/isolatedReviewWorld');

const read=(w,p)=>fs.readFileSync(path.join(w.root,p,'marker.txt'),'utf8');

function intact(w,before){assert.equal(read(w,'work/p0'),'NEW');assert.equal(read(w,'work/p1'),'SIBLING');assert.equal(JSON.stringify(w.queue),before);assert.equal(w.stats.queueWrites,0);assert.equal(w.stats.leaseCalls,0);}
module.exports={test,assert,fs,path,vm,world,read,intact};
