// 실제 로컬 모델로 턱·목 연결, 회전·단체·그늘, 취소·재시도·워커 해제를 확인한다.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('../host/node_modules/@playwright/test');
const {startPreview}=require('./camera-preview.cjs');
(async()=>{
 const preview=await startPreview();let browser;
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext(),page=await context.newPage(),external=[],errors=[];
  context.on('request',request=>{if(!request.url().startsWith(preview.url)&&!request.url().startsWith('blob:')&&!request.url().startsWith('data:'))external.push(request.url());});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(preview.url+'/camera');
  await page.evaluate(()=>{
   const NativeWorker=window.Worker;window.skinJobs={started:0,active:0,peak:0,ended:0};
   window.Worker=class extends NativeWorker{
    constructor(...args){
     super(...args);const jobs=window.skinJobs;jobs.started++;jobs.active++;jobs.peak=Math.max(jobs.peak,jobs.active);let ended=false;
     const terminate=this.terminate.bind(this);this.terminate=()=>{if(!ended){ended=true;jobs.active--;jobs.ended++;}terminate();};
     this.addEventListener('message',event=>{if(event.data.faces&&!event.data.source)window.lastTestFaces=event.data.faces;});
     if(window.abortNextSkinJob){window.abortNextSkinJob=false;setTimeout(()=>window.testAbort.abort(),0);}
    }
   };
  });
  const bytes=[...fs.readFileSync(path.join(__dirname,'../tests/fixtures/beauty-portrait.jpg'))];
  const result=await page.evaluate(async bytes=>{
   const file=new File([new Uint8Array(bytes)],'portrait.jpg',{type:'image/jpeg'}),base=await CameraBeauty.decode(file);
   window.testSkinFile=file;window.testSkinBase=base;
   let ticks=0;const timer=setInterval(()=>ticks++,10),start=performance.now();
   const prepared=await CameraBeauty.prepare(file,{canvas:base});clearInterval(timer);
   const faces=window.lastTestFaces,face=faces[0],w=base.width,h=base.height;
   const forehead=face[10],chin=face[152];
   const samples=[-.05,0,.06,.12].map(d=>{
    const x=Math.round((chin.x+(chin.x-forehead.x)*d)*w),y=Math.round((chin.y+(chin.y-forehead.y)*d)*h);
    let alpha=0,tone=0;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const p=(y+dy)*w+x+dx;alpha+=prepared.alpha[p];tone+=prepared.tone[p];}
    return {alpha:alpha/25,tone:tone/25};
   });
   const before=skinJobs.started,deltas=[];
   for(const strength of [0,35,70,100]){
    const output=CameraBeauty.paint(prepared,strength).getContext('2d').getImageData(0,0,w,h).data;
    let changed=0,outside=0,sum=0,count=0;
    for(let p=0,i=0;p<prepared.alpha.length;p++,i+=4){
     const diff=Math.abs(output[i]-prepared.source.data[i])+Math.abs(output[i+1]-prepared.source.data[i+1])+Math.abs(output[i+2]-prepared.source.data[i+2]);
     if(diff){changed++;if(!prepared.alpha[p]&&!prepared.tone[p])outside++;}
     if(prepared.tone[p]>250){sum+=diff/3;count++;}
    }
    deltas.push({strength,changed,outside,mean:sum/count});
   }
   const canvas=document.createElement('canvas');canvas.width=w*2;canvas.height=h;
   const ctx=canvas.getContext('2d');ctx.putImageData(prepared.source,0,0);ctx.drawImage(prepared.canvas,w,0);
   const image=canvas.toDataURL('image/png');canvas.width=canvas.height=1;
   // 이후 사진은 비교용 원본 픽셀에서 다시 만든다.
   base.getContext('2d').putImageData(prepared.source,0,0);
   const controls=[[80,450],[350,150],[350,750],[(face[33].x+face[133].x)*w/2,(face[33].y+face[133].y)*h/2],[(face[61].x+face[291].x)*w/2,(face[61].y+face[291].y)*h/2]].map(([x,y])=>{const p=Math.round(y)*w+Math.round(x);return {alpha:prepared.alpha[p],tone:prepared.tone[p]};});
   return {samples,controls,deltas,faces:prepared.faces,elapsedMs:performance.now()-start,ticks,jobs:{...skinJobs},noNewJobs:before===skinJobs.started,image};
  },bytes);
  fs.writeFileSync(path.join(__dirname,'../output/camera-skin-comparison.png'),Buffer.from(result.image.split(',')[1],'base64'));delete result.image;
  assert.equal(result.faces,1);assert.ok(result.ticks>3,'model and filtering work must not freeze the UI thread');
  assert.equal(result.jobs.active,0);assert.equal(result.jobs.peak,1);assert.equal(result.jobs.started,2);assert.equal(result.noNewJobs,true);
  assert.equal(result.deltas[0].changed,0);
  for(const item of result.deltas)assert.equal(item.outside,0);
  for(const sample of result.samples){assert.ok(sample.tone>180,'jaw and adjacent neck retain the same tone treatment');assert.ok(sample.alpha>120);}
  for(const control of result.controls){assert.equal(control.alpha,0);assert.equal(control.tone,0,'background, hair, clothes, eyes and lips remain excluded');}
  assert.ok(result.deltas[3].mean>result.deltas[1].mean*2);

  const variants=await page.evaluate(async()=>{
   const base=testSkinBase,file=testSkinFile,results=[];
   for(const kind of ['rotated','shadow','group']){
    const c=document.createElement('canvas');c.width=kind==='group'?base.width*2:base.width;c.height=base.height;const ctx=c.getContext('2d');
    ctx.fillStyle='#888888';ctx.fillRect(0,0,c.width,c.height);
    if(kind==='rotated'){ctx.translate(c.width/2,c.height/2);ctx.rotate(.22);ctx.drawImage(base,-base.width/2,-base.height/2);ctx.resetTransform();}
    else{ctx.drawImage(base,0,0);if(kind==='group')ctx.drawImage(base,base.width,0);}
    if(kind==='shadow'){
     const data=ctx.getImageData(0,0,c.width,c.height),chin=lastTestFaces[0][152].y*c.height;
     for(let y=0;y<c.height;y++){const factor=1-.25*Math.exp(-(((y-chin)/55)**2));for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;for(let ch=0;ch<3;ch++)data.data[i+ch]*=factor;}}
     ctx.putImageData(data,0,0);
    }
    const p=await CameraBeauty.prepare(file,{canvas:c});CameraBeauty.paint(p,100);
    const output=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let outside=0;
    for(let n=0,i=0;n<p.alpha.length;n++,i+=4)if(!p.alpha[n]&&!p.tone[n]&&(output[i]!==p.source.data[i]||output[i+1]!==p.source.data[i+1]||output[i+2]!==p.source.data[i+2]))outside++;
    results.push({kind,faces:p.faces,outside});c.width=c.height=1;
   }
   return results;
  });
  for(const item of variants){assert.equal(item.faces,item.kind==='group'?2:1);assert.equal(item.outside,0);}
  const cancelled=await page.evaluate(async()=>{
   window.testAbort=new AbortController();window.abortNextSkinJob=true;
   try{await CameraBeauty.prepare(testSkinFile,{canvas:testSkinBase,signal:testAbort.signal});return 'did not cancel';}catch(error){return error.name;}
  });
  assert.equal(cancelled,'AbortError');assert.equal(await page.evaluate(()=>skinJobs.active),0);
  await context.route('**/selfie_multiclass_256x256.tflite',route=>route.fulfill({status:503,body:'test unavailable'}));
  const failed=await page.evaluate(async()=>{
   const create=document.createElement.bind(document);let owned;
   document.createElement=(tag,...args)=>{const element=create(tag,...args);if(tag==='canvas')owned=element;return element;};
   try{await CameraBeauty.prepare(testSkinFile);return {failed:false};}
   catch{return {failed:true,released:owned?.width===1&&owned?.height===1};}
   finally{document.createElement=create;}
  });
  assert.deepEqual(failed,{failed:true,released:true});assert.equal(await page.evaluate(()=>skinJobs.active),0);
  await context.unroute('**/selfie_multiclass_256x256.tflite');
  assert.equal(await page.evaluate(async()=>{const p=await CameraBeauty.prepare(testSkinFile,{canvas:testSkinBase});return p.faces;}),1,'a failed model load can be retried');
  assert.equal(await page.evaluate(()=>skinJobs.active),0);assert.equal(await page.evaluate(()=>skinJobs.peak),1);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,...result,variants}));
 }finally{if(browser)await browser.close();await preview.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
