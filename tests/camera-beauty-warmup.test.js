const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function fixture(engine={}){
 const timers=new Map();let sequence=0,decodes=0,prepares=0;
 const context={window:{CameraBeauty:{async decode(){decodes++;return {width:100,height:100};},async prepare(file,{canvas}){prepares++;return {canvas};},...engine}},AbortController,DOMException,Error,
  setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../host/public/camera-beauty-warmup.js'),'utf8'),context);
 return {cache:new context.window.CameraBeautyWarmup(),timers,counts:()=>({decodes,prepares}),fire(ms){const found=[...timers.values()].find(timer=>timer.ms===ms);assert.ok(found);found.fn();}};
}
test('one warm photo is transferred to its editor without duplicate decode or analysis; replacement frees the previous photo',async()=>{
 const f=fixture(),a={},b={},first=f.cache.start(a);await first.ready;
 const canvas=first.canvas;
 assert.deepEqual(f.counts(),{decodes:1,prepares:1});
 assert.equal(f.cache.take(a),first);f.cache.clear();assert.equal(canvas.width,100,'claimed editor owns its canvas');
 first.dispose();assert.equal(canvas.width,1);
 const next=f.cache.start(a);await next.ready;const oldCanvas=next.canvas;
 const newest=f.cache.start(b);await newest.ready;
 assert.equal(next.controller.signal.aborted,true);assert.equal(oldCanvas.width,1);assert.equal(f.cache.cached.file,b);
 f.cache.clear();assert.equal(newest.canvas,null);assert.equal(f.timers.size,0);
});
test('idle expiry releases a ready photo; activity restarts the idle timer without analysing again',async()=>{
 const f=fixture(),job=f.cache.start({});await job.ready;const canvas=job.canvas;
 const timer=[...f.timers.keys()][0];f.cache.touch();assert.equal(f.timers.has(timer),false);
 f.fire(60000);assert.equal(f.cache.cached,null);assert.equal(canvas.width,1);assert.deepEqual(f.counts(),{decodes:1,prepares:1});
});
test('a late decode after cancellation releases its canvas and never starts inference',async()=>{
 let resolve;const f=fixture({decode:()=>new Promise(done=>{resolve=done;})}),job=f.cache.start({});f.cache.clear();
 const canvas={width:2048,height:1536};resolve(canvas);assert.equal(await job.ready,null);
 assert.equal(canvas.width,1);assert.equal(f.counts().prepares,0);
});
test('model failure remains retryable and a timeout aborts rather than retaining a worker forever',async()=>{
 const f=fixture({prepare:async()=>{throw new Error('temporary');}}),job=f.cache.start({});await job.ready;
 assert.equal(job.stage,'error');assert.equal(job.error.message,'temporary');f.cache.clear();
 const stalled=fixture({prepare:(file,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stop','AbortError'))))});
 const pending=stalled.cache.start({});await pending.base;await Promise.resolve();
 stalled.fire(45000);assert.equal(await pending.ready,null);assert.equal(pending.controller.signal.aborted,true);assert.equal(pending.stage,'error');stalled.cache.clear();
});
