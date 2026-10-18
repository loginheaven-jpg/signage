// 실제 결제·외부 사진 전송 없이 AI API와 모바일 편집 전체 흐름을 검증한다.
const {chromium}=require('../host/node_modules/@playwright/test');
const sharp=require('../host/node_modules/sharp');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startPreview}=require('./camera-preview.cjs');
(async()=>{
 let browser,preview;const calls=[],errors=[];let slow=false,failed=false;
 try{
  const generated=await sharp({create:{width:1200,height:900,channels:3,background:'#cf5270'}}).jpeg().toBuffer();
  preview=await startPreview({ai:{env:{GEMINI_API_KEY:'fake-for-test'},generate:async input=>{
   calls.push(input);if(failed)throw new Error('fake unavailable');
   if(slow)await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
   return generated;
  }}});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(preview.url+'/camera');await page.locator('[data-mode="both"]').click();await page.locator('#uploader').fill('AI 검증');
  await page.locator('#chooseSite').click();await page.locator('[data-site-id="screen"]').click();await page.locator('#siteDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  await page.locator('#chooseFolder').click();await page.locator('[data-folder-id="event-2026"]').click();await page.locator('#folderDialog').waitFor({state:'hidden'});await page.locator('#saveLocation').click();await page.waitForFunction(()=>!assigningLocation);
  await page.locator('#galleryInput').setInputFiles(preview.photo);await page.locator('.beautyEdit').click();await page.waitForFunction(()=>beautyBase&&!beautyProcessing&&aiEditor.config);
  await page.locator('#aiTab').click();assert.equal(await page.locator('#aiGenerate').isDisabled(),true,'requires an explicit consent');
  await page.locator('#aiEffect').selectOption('watercolor');await page.locator('#aiConsent').check();await page.locator('#aiGenerate').click();
  await page.waitForFunction(()=>!!beautyAIFile&&!aiEditor.busy);assert.equal(calls.length,1);assert.equal(calls[0].kind,'watercolor');assert.ok(calls[0].image);
  const colors=await page.evaluate(()=>({original:[...el('beautyOriginal').getContext('2d').getImageData(10,10,1,1).data],edited:[...renderedBeauty().getContext('2d').getImageData(10,10,1,1).data]}));assert.notDeepEqual(colors.original,colors.edited);
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyOriginal').isVisible(),true);await page.locator('#compareBeauty').click();
  await page.locator('#colorTab').click();await page.locator('[data-photo-color="warm"]').click();await page.locator('#aiTab').click();assert.equal(calls.length,1,'local tabs do not call AI');
  await page.locator('#aiEffect').selectOption('frame');await page.locator('#aiTheme').fill('가을 음악회, 꽃과 음표');await page.locator('#aiGenerate').click();
  await page.waitForFunction(()=>!!aiEditor.frameImage&&!aiEditor.busy);assert.equal(calls.length,2);assert.equal(calls[1].image,undefined,'frame generation never sends photo');
  const frameId=await page.evaluate(()=>beautyEffects.event.templateId);assert.ok(frameId);
  await page.locator('#frameTab').click();await page.locator('#frameEventTitle').fill('가을 음악회');await page.locator('#frameEventDate').fill('2026-10-18');
  await page.waitForFunction(()=>beautyCompositionKey.includes('가을 음악회'));
  const corner=await page.evaluate(()=>[...renderedBeauty().getContext('2d').getImageData(0,0,1,1).data]);assert.ok(corner[0]>180&&corner[1]<130,'generated art is painted into the frame');
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});await page.waitForFunction(()=>selected[0].aiFile&&selected[0].beautyFile);
  await page.reload();await page.locator('#continueResume').click();await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!!beautyAIFile&&!!aiEditor.frameImage&&!beautyProcessing);
  assert.equal(await page.evaluate(()=>beautyEffects.event.templateId),frameId);assert.equal(calls.length,2);
  await page.locator('#frameTab').click();await page.locator('#eventFrameTemplate').selectOption('');await page.waitForFunction(()=>!aiEditor.frameId);
  await page.locator('#eventFrameTemplate').selectOption(frameId);await page.waitForFunction(()=>aiEditor.frameId===beautyEffects.event.templateId&&!aiEditor.loadingFrame);
  assert.equal(calls.length,2,'reusing the frame does not call AI');
  await page.locator('#aiTab').click();await page.locator('#aiDiscard').click();await page.waitForFunction(()=>!beautyAIFile&&!beautyProcessing);assert.equal(await page.evaluate(()=>beautyEffects.color),'warm');
  slow=true;await page.locator('#aiEffect').selectOption('cartoon');await page.locator('#aiConsent').check();await page.locator('#aiGenerate').click();await page.waitForFunction(()=>!!aiEditor.job);
  await page.waitForTimeout(150);await page.locator('#aiCancel').click();await page.waitForFunction(()=>!aiEditor.busy);assert.equal(await page.evaluate(()=>beautyAIFile),null);
  assert.equal(calls[2].signal.aborted,true);slow=false;failed=true;await page.locator('#aiGenerate').click();await page.waitForFunction(()=>!aiEditor.busy);assert.equal(await page.evaluate(()=>beautyAIFile),null);failed=false;
  // 실패나 취소가 이미 저장한 사진을 바꾸지 않는다. 닫으면 저장 전 편집은 버린다.
  await page.locator('#closeBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>!!selected[0].aiFile),true);
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!!aiEditor.frameImage&&!beautyProcessing);await page.locator('#aiTab').click();
  for(const viewport of [{width:320,height:568},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.screenshot({path:'output/camera-ai-'+viewport.width+'.png'});const bounds=await page.locator('#applyBeauty').boundingBox();assert.ok(bounds.y+bounds.height<=viewport.height+1,'continue button remains visible: '+JSON.stringify({viewport,bounds}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.screenshot({path:'output/camera-ai-mobile.png'});
  await page.locator('#closeBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});await page.locator('#send').click();await page.waitForFunction(()=>!busy&&!selected.length&&!originals.length);
  assert.equal(preview.published.length,1);const record=[...preview.archive.records.values()][0],original=record.driveId?preview.remote.get(record.driveId).bytes:fs.readFileSync(preview.archive.localPath(record));assert.deepEqual(original,fs.readFileSync(preview.photo),'true original is archived');assert.notDeepEqual(preview.published[0].bytes,original);
  const other=await browser.newPage();await other.goto(preview.url+'/camera');const shared=await other.evaluate(async()=>{const config=await(await fetch('/live/api/camera/ai/config')).json();return config.frames;});assert.equal(shared[0].id,frameId,'another device sees reusable event frame');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,calls:calls.length,frameId,originalArchived:true,colors}));
 }finally{if(browser)await browser.close();if(preview)await preview.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
