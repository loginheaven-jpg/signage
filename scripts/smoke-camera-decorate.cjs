const cameraUI=require('./helpers/camera-ui.cjs');
// 행사 프레임과 벡터 꾸미기: 로컬 서버·가짜 Drive만 사용한다.
const {chromium}=require('../host/node_modules/@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startPreview}=require('./camera-preview.cjs');
(async()=>{
 const preview=await startPreview();let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3}),errors=[],models=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/vendor/mediapipe/'))models.push(r.url());});
  await page.goto(preview.url+'/camera');await cameraUI.click(page,'[data-mode="both"]');await cameraUI.fill(page,'#uploader','꾸미기 검증');
  await cameraUI.click(page,'#chooseSite');await cameraUI.click(page,'[data-site-id="screen"]');await page.locator('#siteDialog').waitFor({state:'hidden'});await cameraUI.click(page,'#useSettings');
  await cameraUI.click(page,'#chooseFolder');await cameraUI.click(page,'[data-folder-id="event-2026"]');await page.locator('#folderDialog').waitFor({state:'hidden'});await cameraUI.click(page,'#saveLocation');await page.waitForFunction(()=>!assigningLocation);
  await page.locator('#galleryInput').setInputFiles(preview.photo);await cameraUI.click(page,'.beautyEdit');await page.waitForFunction(()=>beautyBase&&!beautyProcessing);
  await cameraUI.click(page,'#frameTab');await cameraUI.click(page,'[data-photo-frame="event"]');await page.locator('#eventFrameFields').waitFor();
  assert.ok((await page.locator('#frameEventTitle').inputValue()).includes('목자'));
  assert.match(await page.locator('#frameEventDate').inputValue(),/^\d{4}-\d{2}-\d{2}$/);
  await cameraUI.fill(page,'#frameEventTitle','가을 가족예배');await cameraUI.fill(page,'#frameEventDate','2026-10-18');
  await page.waitForFunction(()=>beautyCompositionKey.includes('가을 가족예배')&&beautyCompositionKey.includes('2026-10-18'));
  const eventPixels=await page.evaluate(()=>{
   const image=renderedBeauty(),ctx=image.getContext('2d');
   return {width:image.width,height:image.height,corner:Array.from(ctx.getImageData(0,0,1,1).data),footerInk:[...ctx.getImageData(30,image.height-150,image.width-60,120).data].filter((v,i)=>i%4===0&&v<100).length};
  });
  assert.deepEqual(eventPixels.corner,[240,245,236,255]);assert.ok(eventPixels.height>1000);assert.ok(eventPixels.footerInk>50,'event text is drawn into the actual image');
  await page.evaluate(()=>{window.fullCompositions=0;const compose=CameraBeauty.compose;CameraBeauty.compose=(...args)=>{window.fullCompositions++;return compose(...args);};});
  await page.locator('#frameEventTitle').evaluate(input=>{for(let i=0;i<20;i++){input.value='가을 가족예배 '+i;input.dispatchEvent(new Event('input',{bubbles:true}));}});
  await page.waitForFunction(()=>beautyCompositionKey.includes('가을 가족예배 19'));
  assert.equal(await page.evaluate(()=>window.fullCompositions),1,'typing bursts coalesce to one full composition');
  await cameraUI.fill(page,'#frameEventTitle','가을 가족예배');await page.waitForFunction(()=>beautyCompositionKey.includes('가을 가족예배')&&!beautyCompositionKey.includes('예배 19'));
  await cameraUI.click(page,'#decorateTab');
  for(const type of ['heart','star','speech','text']){await cameraUI.click(page,'[data-add-decoration="'+type+'"]');await page.waitForFunction(type=>decorationEditor.current()?.type===type,type);}
  await cameraUI.fill(page,'#decorationText','함께라서 좋아요');await page.locator('#decorationColor').selectOption('#ffffff');
  const current=await page.evaluate(()=>{decorationEditor.draw();const item=decorationEditor.current(),box=decorationEditor.boxes.find(b=>b.id===item.id),rect=document.querySelector('#decorationOverlay').getBoundingClientRect();return {id:item.id,x:item.x,y:item.y,startX:rect.left+box.x,startY:rect.top+box.y};});
  await page.evaluate(()=>{window.fullCompositions=0;window.facePaints=0;const paint=CameraBeauty.paint;CameraBeauty.paint=(...args)=>{window.facePaints++;return paint(...args);};});
  await page.mouse.move(current.startX,current.startY);await page.mouse.down();await page.mouse.move(current.startX+35,current.startY-28,{steps:20});await page.mouse.up();
  const moved=await page.evaluate(id=>beautyEffects.decorations.find(item=>item.id===id),current.id);
  assert.ok(Math.abs(moved.x-current.x)>0.02&&Math.abs(moved.y-current.y)>0.02,'pointer dragging moves the selected item');
  await page.locator('#decorationOverlay').focus();await page.locator('#decorationOverlay').press('ArrowRight');
  assert.ok(await page.evaluate(x=>decorationEditor.current().x>x,moved.x),'keyboard movement works as well');
  await page.locator('#decorationSize').evaluate(input=>{for(let i=10;i<=18;i++){input.value=i;input.dispatchEvent(new Event('input',{bubbles:true}));}});
  await cameraUI.click(page,'#rotateDecoration');
  assert.equal(await page.evaluate(()=>decorationEditor.current().size),0.18);assert.equal(await page.evaluate(()=>decorationEditor.current().rotation),15);
  assert.equal(await page.evaluate(()=>window.fullCompositions),0,'dragging, sizing and rotating never recompose the large photo');
  assert.equal(await page.evaluate(()=>window.facePaints),0,'decorations do not rerun face painting');
  await cameraUI.click(page,'#removeDecoration');assert.equal(await page.evaluate(()=>beautyEffects.decorations.length),3);
  await cameraUI.click(page,'[data-add-decoration="text"]');await cameraUI.fill(page,'#decorationText','');
  await page.waitForFunction(()=>!decorationEditor.boxes.some(box=>box.id===decorationEditor.selected));
  assert.equal(await page.evaluate(()=>CameraBeauty.normalizeEffects(beautyEffects).decorations.some(item=>item.type==='text')),false,'cleared text is absent from preview and export');
  await cameraUI.fill(page,'#decorationText','함께라서 좋아요');
  while(await page.evaluate(()=>beautyEffects.decorations.length)<8)await cameraUI.click(page,'[data-add-decoration="heart"]');
  assert.equal(await page.locator('[data-add-decoration="heart"]').isDisabled(),true,'bounded item count');
  const memory=await page.evaluate(()=>{decorationEditor.draw();const c=document.querySelector('#decorationOverlay'),r=c.getBoundingClientRect();const start=performance.now();for(let i=0;i<100;i++)decorationEditor.draw();return {overlayBytes:c.width*c.height*4,pixelLimit:Math.ceil(r.width*2)*Math.ceil(r.height*2)*4,metadataBytes:new TextEncoder().encode(JSON.stringify(beautyEffects)).length,averageVectorMs:(performance.now()-start)/100};});
  assert.ok(memory.overlayBytes<=memory.pixelLimit);assert.ok(memory.metadataBytes<4096);
  await cameraUI.click(page,'#compareBeauty');assert.equal(await page.locator('#decorationOverlay').isVisible(),false);
  assert.equal(await page.evaluate(()=>beautyEffects.decorations.length),8);await cameraUI.click(page,'#compareBeauty');
  const expected=await page.evaluate(async()=>{const c=CameraBeauty.compose(beautyBase,beautyEffects);try{return Array.from(new Uint8Array(await(await CameraBeauty.exportPhoto(c,beautyEntry.file)).arrayBuffer()));}finally{c.width=c.height=1;}});
  for(const size of [{width:320,height:568},{width:390,height:844}]){
   await page.setViewportSize(size);assert.equal(await page.locator('#beautyDialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true);
   assert.equal(await page.locator('#applyBeauty').evaluate(b=>b.getBoundingClientRect().bottom<=innerHeight+1),true);
  }
  await page.screenshot({path:path.join(__dirname,'../output/camera-decorate-mobile.png')});
  const savedEffects=await page.evaluate(()=>CameraBeauty.normalizeEffects(beautyEffects));
  const identities=await page.evaluate(async effects=>{
   const r={file:{name:'same.png',size:100,lastModified:1},beautyFile:{size:200},beautyLevel:0,photoEffects:effects};
   const s={target:{year:2026,folderName:'행사'},uploaderName:'검증',date:'2026-10-18T10:00'};
   const first=await archiveRequestId(r,s);r.photoEffects.decorations[0].id='new-editor-id';const renamed=await archiveRequestId(r,s);
   r.photoEffects.decorations[0].x=0.91;const moved=await archiveRequestId(r,s);return {first,renamed,moved};
  },savedEffects);
  assert.equal(identities.first,identities.renamed,'UI-only IDs do not change the archive identity');assert.notEqual(identities.first,identities.moved);
  await cameraUI.click(page,'#applyBeauty');await page.locator('#beautyDialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#decorationOverlay').width===1);
  assert.deepEqual(await page.evaluate(async()=>Array.from(new Uint8Array(await selected[0].beautyFile.arrayBuffer()))),expected,'saved image matches the common vector renderer');
  await page.reload();await cameraUI.click(page,'#continueResume');assert.deepEqual(await page.evaluate(()=>selected[0].photoEffects),savedEffects);
  await cameraUI.click(page,'.beautyEdit');await page.waitForFunction(()=>beautyBase&&!beautyProcessing);await cameraUI.click(page,'#frameTab');
  assert.equal(await page.locator('#frameEventTitle').inputValue(),'가을 가족예배');assert.equal(await page.locator('#frameEventDate').inputValue(),'2026-10-18');
  await cameraUI.click(page,'#decorateTab');assert.equal(await page.locator('#decorationCount').textContent(),'8/8');
  await cameraUI.click(page,'#closeBeauty');await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await cameraUI.click(page,'#send');await page.waitForFunction(()=>!busy&&selected.length===0);await page.waitForFunction(()=>originals.length===0);
  assert.equal(preview.published.length,1);assert.equal(preview.archive.records.size,1);
  const record=[...preview.archive.records.values()][0],original=record.driveId?preview.remote.get(record.driveId).bytes:fs.readFileSync(preview.archive.localPath(record));
  assert.deepEqual(original,fs.readFileSync(preview.photo),'original archive remains untouched');
  assert.notDeepEqual(preview.published[0].bytes,original);
  assert.ok(models.every(url=>/\/(vision_bundle\.mjs|face_landmarker\.task|wasm\/vision_wasm_(nosimd_)?internal\.(js|wasm))$/.test(url)),'only shared skin preparation tools are loaded, not extra decoration models');
  assert.ok(models.filter(url=>url.endsWith('face_landmarker.task')).length<=2,'at most one automatic face preparation per editor opening');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,eventPixels,memory,items:8}));
 }finally{if(browser)await browser.close();await preview.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
