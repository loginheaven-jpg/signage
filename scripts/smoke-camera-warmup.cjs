const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('../host/node_modules/@playwright/test');
const {startPreview}=require('./camera-preview.cjs');
const ui=require('./helpers/camera-ui.cjs');
(async()=>{
 const preview=await startPreview();let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(preview.url+'/camera');
  await ui.click(page,'[data-mode=both]');await ui.fill(page,'#uploader','미리 준비 검증');
  await ui.click(page,'#chooseSite');await ui.click(page,'[data-site-id=screen]');await ui.click(page,'#useSettings');
  await page.evaluate(()=>{
   const prepare=CameraBeauty.prepare;window.skinPrepareCalls=0;
   window.prepareGate=new Promise(resolve=>window.releasePreparation=resolve);
   CameraBeauty.prepare=async(file,options)=>{
    skinPrepareCalls++;
    await Promise.race([prepareGate,new Promise((resolve,reject)=>{if(options.signal.aborted)reject(new DOMException('cancel','AbortError'));else options.signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true});})]);
    return prepare(file,options);
   };
  });
  const bytes=fs.readFileSync(path.join(__dirname,'../tests/fixtures/beauty-portrait.jpg'));
  const photo=name=>({name,mimeType:'image/jpeg',buffer:bytes});
  await page.locator('#shootInput').setInputFiles(photo('first.jpg'));
  await page.waitForFunction(()=>beautyWarmup.cached?.canvas&&skinPrepareCalls===1);
  await page.evaluate(()=>{window.warmPhoto=beautyWarmup.cached;window.warmCanvas=warmPhoto.canvas;});
  await ui.click(page,'.beautyEdit');await page.waitForFunction(()=>beautyBase&&!beautyProcessing);
  assert.equal(await page.evaluate(()=>beautyBase===warmCanvas),true,'editor takes the captured photo instead of decoding twice');
  assert.equal(await page.locator('#beautyProgress').isVisible(),true);
  assert.equal(await page.locator('#beautyStrength').isEnabled(),true);
  for(const value of [35,75,60])await page.locator('#beautyStrength').evaluate((slider,value)=>{slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await page.waitForFunction(()=>document.getElementById('beautyStrengthValue').textContent==='60');
  assert.equal(await page.locator('#beautyStrength').inputValue(),'60','the thumb does not jump back while preparing');
  assert.equal(await page.locator('#applyBeauty').isDisabled(),true,'an unfinished selected correction cannot be exported');
  await ui.click(page,'#colorTab');await ui.click(page,'[data-photo-color=warm]');
  assert.equal(await page.evaluate(()=>beautyEffects.color),'warm','other effects remain usable while skin prepares');
  await ui.click(page,'#skinTab');
  await page.screenshot({path:path.join(__dirname,'../output/camera-preparing.png')});
  await page.evaluate(()=>releasePreparation());await page.waitForFunction(()=>!!beautyPrepared,{timeout:60000});
  assert.equal(await page.locator('#beautyStrength').inputValue(),'60');assert.equal(await page.evaluate(()=>skinPrepareCalls),1);
  assert.equal(await page.locator('#beautyProgress').isVisible(),false);assert.equal(await page.locator('#applyBeauty').isEnabled(),true);
  assert.equal(await page.evaluate(()=>{
   const original=document.getElementById('beautyOriginal').getContext('2d').getImageData(0,0,beautyBase.width,beautyBase.height).data;
   return original.every((value,index)=>value===beautyPrepared.source.data[index]);
  }),true,'original comparison stays original after a prepared photo is claimed');
  await ui.click(page,'#closeBeauty');await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>warmCanvas.width===1);
  assert.equal(await page.evaluate(()=>warmCanvas.width),1);
  await page.locator('#shootInput').setInputFiles(photo('second.jpg'));
  await page.waitForFunction(()=>beautyWarmup.cached?.file.name==='second.jpg'&&beautyWarmup.cached.canvas);
  await page.evaluate(()=>{window.oldWarm=beautyWarmup.cached;window.oldWarmCanvas=oldWarm.canvas;});
  await page.locator('#shootInput').setInputFiles(photo('third.jpg'));
  await page.waitForFunction(()=>beautyWarmup.cached?.file.name==='third.jpg');
  assert.equal(await page.evaluate(()=>oldWarm.controller.signal.aborted&&oldWarmCanvas.width===1),true);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null);
  await page.locator('#galleryInput').setInputFiles([photo('gallery1.jpg'),photo('gallery2.jpg')]);
  await page.waitForFunction(()=>selected.length===5);   // 미리보기를 만드는 동안 다음 촬영이 겹치지 않게 기다린다
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null,'bulk gallery selection does not warm every photo');
  // 뽀샤시를 열지 않고 연달아 두 장을 찍었으면(연속 촬영) 다음 사진은 미리 준비하지 않는다. 뽀샤시를 열면 다시 준비한다.
  await page.locator('#shootInput').setInputFiles(photo('fourth.jpg'));
  await page.waitForFunction(()=>selected.at(-1)?.file.name==='fourth.jpg'&&!document.getElementById('review').hidden);
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null,'two captures in a row without opening the editor stop the speculative preparation');
  assert.equal(await page.evaluate(()=>storage.get('warmStreak')),2);
  await page.locator('.beautyEdit').last().click();await page.waitForFunction(()=>beautyBase&&!beautyProcessing);
  assert.equal(await page.evaluate(()=>storage.get('warmStreak')),0,'opening the editor resumes preparation for the next capture');
  await ui.click(page,'#closeBeauty');await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('#shootInput').setInputFiles(photo('fourth-b.jpg'));
  await page.waitForFunction(()=>beautyWarmup.cached?.file.name==='fourth-b.jpg');
  await ui.click(page,'#home');await page.waitForFunction(()=>beautyWarmup.cached===null);
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
  await page.locator('#shootInput').setInputFiles(photo('late-visible.jpg'));
  await page.waitForFunction(()=>beautyWarmCandidate?.entry.file.name==='late-visible.jpg');
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>beautyWarmup.cached?.file.name==='late-visible.jpg');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null,'returning to the app does not recreate a discarded warm cache');
  assert.deepEqual(errors,[]);console.log('Camera warmup passed: capture preparation reuse, responsive latest slider value, visible stages, concurrent color editing, original comparison, replacement/page exit cleanup and bulk exclusion.');
 }finally{if(browser)await browser.close();await preview.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
