'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('../host/node_modules/express');
const sharp = require('../host/node_modules/sharp');
const { mountCameraAI, generateWithGemini } = require('../host/camera-ai');
async function fixture(t, options = {}) {
  const root=options.root||fs.mkdtempSync(path.join(os.tmpdir(),'signage-ai-'));
  const app=express();app.use(express.json());
  app.use('/live/api/camera/ai',(req,res,next)=>{
    if(!req.get('x-test-owner'))return res.sendStatus(401);
    req.cameraOwner=req.get('x-test-owner');next();
  });
  const bytes=await sharp({create:{width:320,height:240,channels:3,background:'#ce5670'}}).jpeg().toBuffer();
  const calls=[];
  const ai=mountCameraAI(app,{root,env:{GEMINI_API_KEY:'test-only',CAMERA_AI_OWNER_DAILY_LIMIT:'4',...options.env},generate:async input=>{calls.push(input);return options.generate?options.generate(input,bytes):bytes;}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{ai.close();await new Promise(r=>server.close(r));if(!options.keep)fs.rmSync(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port+'/live/api/camera/ai/';
  const request=(route,options={},owner='one')=>fetch(base+route,{...options,headers:{...(owner?{'x-test-owner':owner}:{}),...options.headers}});
  const submit=(kind='cleanup',extra={},owner='one')=>{
    const form=new FormData();form.set('kind',kind);form.set('requestId',crypto.randomUUID());form.set('consent','yes');
    if(kind==='frame')form.set('theme','가을 음악회');else form.set('photo',new Blob([bytes],{type:'image/jpeg'}),'photo.jpg');
    for(const [key,value] of Object.entries(extra))form.set(key,value);
    return request('jobs',{method:'POST',body:form},owner);
  };
  const done=async id=>{for(let i=0;i<100;i++){const response=await request('jobs/'+id),job=await response.json();if(job.status!=='working')return job;await new Promise(r=>setTimeout(r,10));}throw new Error('job did not finish');};
  return {root,request,submit,done,calls,ai,bytes};
}
test('AI jobs require login, consent, a valid effect and configured server key',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('config',{},'')).status,401);
  assert.equal((await f.submit('cleanup',{consent:'no'})).status,400);
  assert.equal((await f.submit('unknown')).status,400);
  assert.equal((await f.submit('frame',{theme:''})).status,400);
  assert.equal(f.calls.length,0);
  const config=await (await f.request('config')).json();assert.equal(config.enabled,true);assert.equal(config.remaining,4);assert.ok(!JSON.stringify(config).includes('test-only'));
  const off=await fixture(t,{env:{GEMINI_API_KEY:''}});assert.equal((await off.submit()).status,503);assert.equal(off.calls.length,0);
});
test('one explicit edit, replay without extra cost, owner isolation and durable daily quotas',async t=>{
  const f=await fixture(t);
  const id=crypto.randomUUID(),response=await f.submit('watercolor',{requestId:id});assert.equal(response.status,202);
  assert.equal((await f.done(id)).status,'done');
  assert.equal((await f.submit('watercolor',{requestId:id})).status,200);assert.equal(f.calls.length,1);
  assert.equal((await f.request('jobs/'+id,{},'other')).status,404);
  assert.equal((await f.request('jobs/'+id+'/image',{},'other')).status,404);
  const image=await f.request('jobs/'+id+'/image');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg');
  const sent=await sharp(f.calls[0].image).metadata();assert.ok(sent.width<=1600);assert.equal(sent.exif,undefined);
  const disk=JSON.parse(fs.readFileSync(path.join(f.root,'camera-ai/state.json')));assert.equal(disk.total,1);assert.equal(disk.owners.one,1);
  for(let i=0;i<3;i++){const job=await (await f.submit()).json();await f.done(job.id);}
  assert.equal((await f.submit()).status,429);
  assert.equal((await (await f.request('config')).json()).remaining,0);
});
test('cancel aborts the provider, limits concurrent work, and never exposes a cancelled image',async t=>{
  const f=await fixture(t,{generate:({signal},bytes)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});})});
  const job=await (await f.submit()).json();
  assert.equal((await f.submit()).status,429);
  assert.equal((await f.request('jobs/'+job.id+'/cancel',{method:'POST'},'other')).status,404);
  assert.equal((await f.request('jobs/'+job.id+'/cancel',{method:'POST'})).status,200);
  assert.equal((await f.done(job.id)).status,'cancelled');
  assert.equal((await f.request('jobs/'+job.id+'/image')).status,409);
  assert.equal(f.calls[0].signal.aborted,true);
  const lateId=crypto.randomUUID();
  await f.request('jobs/'+lateId+'/cancel',{method:'POST'});
  const late=await (await f.submit('cleanup',{requestId:lateId})).json();
  assert.equal(late.status,'cancelled');assert.equal(f.calls.length,1,'cancelling before an upload arrives prevents a late billable call');
});
test('event frames survive restart and reuse without calling AI or sending a photo',async t=>{
  const f=await fixture(t,{keep:true});
  const job=await (await f.submit('frame')).json();const ready=await f.done(job.id);assert.equal(ready.status,'done');
  assert.equal(f.calls[0].image,undefined);assert.equal(f.calls[0].theme,'가을 음악회');
  const second=await fixture(t,{root:f.root});
  const config=await (await second.request('config',{},'other')).json();assert.equal(config.frames.length,1);assert.equal(config.frames[0].id,job.id);
  assert.equal((await second.request('frames/'+job.id+'/image',{},'other')).status,200);assert.equal(second.calls.length,0);
  assert.equal((await second.request('jobs/'+job.id)).status,404);
  assert.equal(config.remaining,4);
});
test('the installed Gemini SDK sends the documented multimodal request and extracts image output',async()=>{
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
  let body,headers,url,count=0;
  const result=await generateWithGemini({kind:'cleanup',image:bytes,env:{GEMINI_API_KEY:'never-real'},signal:new AbortController().signal,fetch:async(input,options)=>{
    count++;url=String(input);body=JSON.parse(options.body);headers=options.headers;
    return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{inlineData:{mimeType:'image/png',data:bytes.toString('base64')}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,totalTokenCount:30}}),{headers:{'Content-Type':'application/json'}});
  }});
  assert.equal(count,1);assert.match(url,/gemini-3\.1-flash-image:generateContent/);assert.equal(new Headers(headers).get('x-goog-api-key'),'never-real');
  assert.deepEqual(body.generationConfig.responseModalities,['IMAGE','TEXT']);assert.equal(body.generationConfig.imageConfig.imageSize,'1K');
  assert.ok(body.contents[0].parts.some(p=>p.inlineData));assert.deepEqual(result,bytes);
});
