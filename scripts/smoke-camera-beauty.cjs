// 실제 얼굴 모델과 로컬 Drive를 사용한다. 외부 모니터·메일·Drive에는 접속하지 않는다.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startPreview } = require('./camera-preview.cjs');
(async () => {
 const preview = await startPreview(); let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[], external=[];
  const setStrength=value=>page.locator('#beautyStrength').evaluate((slider,value)=>{slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));},value);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(preview.url)&&!r.url().startsWith('blob:')&&!r.url().startsWith('data:'))external.push(r.url());});
  await page.goto(preview.url+'/camera');
  await page.locator('[data-mode=both]').click();await page.locator('#uploader').fill('피부보정 검증');
  await page.locator('#chooseSite').click();await page.locator('[data-site-id=screen]').click();await page.locator('#siteDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  const face=fs.readFileSync(require('node:path').join(__dirname,'../tests/fixtures/beauty-portrait.jpg'));
  await page.locator('#shootInput').setInputFiles({name:'portrait.jpg',mimeType:'image/jpeg',buffer:face});
  await page.locator('#beautyDialog').waitFor();
  assert.equal(await page.evaluate(()=>selected.length),1);
  await page.evaluate(()=>{const prepare=CameraBeauty.prepare;window.beautyPrepareCalls=0;CameraBeauty.prepare=(...args)=>{window.beautyPrepareCalls++;return prepare(...args);};});
  await page.locator('#beautyStrength').press('End');
  await page.waitForFunction(()=>!beautyProcessing && beautyPrepared,{timeout:60000});
  assert.equal(await page.locator('#beautyStrength').inputValue(),'100','slider can initialize the face analysis');
  await page.locator('#toggleBeauty').click();await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='0');
  assert.equal(await page.locator('#toggleBeauty').getAttribute('aria-pressed'),'false');
  await page.locator('#toggleBeauty').click();await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='100');
  await page.evaluate(()=>{
   const paint=CameraBeauty.paint;window.beautyPaintCalls=0;
   CameraBeauty.paint=(...args)=>{window.beautyPaintCalls++;return paint(...args);};
   const slider=document.querySelector('#beautyStrength');
   for(let value=40;value<=61;value++){slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='61');
  assert.equal(await page.evaluate(()=>window.beautyPaintCalls),1,'rapid slider events render once per frame');
  await setStrength(35);await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='35');
  const pixels=await page.evaluate(()=>{
   const {source,smooth,alpha}=beautyPrepared;
   const output=CameraBeauty.paint(beautyPrepared,35).getContext('2d').getImageData(0,0,source.width,source.height).data;
   let changed=0,outside=0,smoothed=0;
   for(let i=0;i<output.length;i+=4){
    const different=output[i]!==source.data[i]||output[i+1]!==source.data[i+1]||output[i+2]!==source.data[i+2];
    if(different){changed++;if(!alpha[i+3])outside++;}
    if(alpha[i+3]&&(smooth[i]!==source.data[i]||smooth[i+1]!==source.data[i+1]))smoothed++;
   }
   const strengths=[0,35,70,100].map(strength=>{
    const image=CameraBeauty.paint(beautyPrepared,strength).getContext('2d').getImageData(0,0,source.width,source.height).data;
    let sum=0,count=0;
    for(let i=0;i<image.length;i+=4)if(alpha[i+3]>250)for(let c=0;c<3;c++){sum+=Math.abs(image[i+c]-source.data[i+c]);count++;}
    return sum/count;
   });
   // 피부색과 무관하게 마스크 가장자리 자체가 넓고 연속적인 완충 구간을 갖는지 확인한다.
   let widest=0,edgeRamp=0,edgeMaxStep=0;
   for(let y=0;y<source.height;y++){
    const row=[];for(let x=0;x<source.width;x++)row.push(alpha[(y*source.width+x)*4+3]);
    const first=row.findIndex(a=>a>0),full=row.findIndex(a=>a>=250);
    let last=row.length-1;while(last>=0&&!row[last])last--;
    if(first>=0&&full>first&&last-first>widest){
     widest=last-first;edgeRamp=full-first;edgeMaxStep=0;
     for(let x=first;x<=full;x++)edgeMaxStep=Math.max(edgeMaxStep,row[x]-(row[x-1]||0));
    }
   }
   return {changed,outside,smoothed,faces:beautyPrepared.faces,strengths,edgeRamp,edgeMaxStep};
  });
  assert.ok(pixels.faces>=1);assert.ok(pixels.changed>1000);assert.ok(pixels.smoothed>1000);assert.equal(pixels.outside,0,'background and excluded features remain unchanged');
  assert.equal(pixels.strengths[0],0);assert.ok(pixels.strengths[1]>4,'natural preset visibly exceeds previous 1.3-level mean change');
  assert.ok(pixels.strengths[2]>pixels.strengths[1]*1.7);assert.ok(pixels.strengths[3]>pixels.strengths[2]);
  assert.ok(pixels.edgeRamp>=10,'outer facial mask has a broad transition instead of a narrow gray ring');
  assert.ok(pixels.edgeMaxStep<=30,'outer transition avoids a sudden brightness step');
  assert.equal(await page.locator('#beautyStrength').inputValue(),'35');
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyOriginal').isVisible(),true);
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyCanvas').isVisible(),true);
  assert.equal(await page.locator('#beautyStrength').inputValue(),'35','comparison preserves the selected strength');
  assert.equal(await page.evaluate(()=>window.beautyPrepareCalls),1,'comparison does not rerun detection');
  await page.screenshot({path:require('node:path').join(__dirname,'../output/camera-beauty-mobile.png')});
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  let natural=await page.evaluate(()=>selected[0].beautyFile.size);assert.ok(natural>1000);
  await page.reload();await page.locator('#continueResume').click();
  assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),natural);
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),35);
  // 이전 버전의 강도 1/2를 35/70으로 해석하고 저장한 원본은 유지한다.
  await page.evaluate(()=>{selected[0].beautyLevel=1;delete selected[0].beautyScale;});
  // 기존 저장 키를 덮어써도 재접속 뒤 예전 보정으로 돌아가지 않는다.
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared,{timeout:60000});
  assert.equal(await page.locator('#beautyStrength').inputValue(),'35','legacy preset migrated when reopening');
  await setStrength(70);await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='70');
  await page.locator('#beautyStrength').press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='69');
  assert.equal(await page.locator('#toggleBeauty').getAttribute('aria-pressed'),'true','custom strength keeps skin retouch enabled');
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  const bright=await page.evaluate(()=>selected[0].beautyFile.size);assert.notEqual(bright,natural);
  await page.reload();await page.locator('#continueResume').click();assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),bright);
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),69);assert.equal(await page.evaluate(()=>selected[0].beautyScale),100);
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  assert.equal(await page.locator('#beautyStrength').inputValue(),'69');
  await page.locator('#beautyStrength').press('ArrowRight');await page.locator('#closeBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),69,'closing discards unsaved slider changes');
  await page.locator('#send').click();await page.waitForFunction(()=>!busy&&selected.length===0);
  await page.waitForFunction(()=>originals.length===0);
  assert.equal(preview.published.length,1);
  assert.equal(preview.archive.records.size,1);
  const record=[...preview.archive.records.values()][0];
  assert.deepEqual(fs.readFileSync(preview.archive.localPath(record)),face);
  // 얼굴이 없는 사진에서는 보정으로 위장하지 않고 원본으로 진행한다.
  await page.locator('#galleryInput').setInputFiles(preview.photo);await page.locator('.beautyEdit').click();
  await setStrength(35);await page.waitForFunction(()=>!beautyProcessing);
  assert.ok((await page.locator('#beautyState').textContent()).includes('얼굴을 찾지 못했습니다'));
  assert.equal(await page.locator('#applyBeauty').isEnabled(),true);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>selected[0].beautyFile),null);
  // 보정을 원본으로 되돌리면 저장된 보정 파일도 제거한다.
  await page.locator('#discard').click();
  await page.locator('#galleryInput').setInputFiles({name:'restore.jpg',mimeType:'image/jpeg',buffer:face});
  await page.locator('.beautyEdit').click();await page.locator('#toggleBeauty').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  assert.equal(await page.locator('#beautyStrength').inputValue(),'50','new photo starts at 50 when enabled');
  await setStrength(35);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  await page.locator('#toggleBeauty').click();await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.reload();await page.locator('#continueResume').click();assert.equal(await page.evaluate(()=>!!selected[0].beautyFile),false);
  // 교회폴더 저장 전용에서도 보정본을 전송한다.
  await page.locator('#discard').click();await page.locator('#home').click();await page.locator('[data-mode="archive"]').click();
  await page.locator('#chooseFolder').click();await page.locator('[data-folder-id="event-2026"]').click();await page.locator('#folderDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  await page.locator('#galleryInput').setInputFiles({name:'archive.jpg',mimeType:'image/jpeg',buffer:face});await page.locator('.beautyEdit').click();
  await setStrength(35);await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  const expected=await page.evaluate(async()=>{const file=await CameraBeauty.file(beautyPrepared,35,beautyEntry.file);return Array.from(new Uint8Array(await file.arrayBuffer()));});
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.locator('#beautyDialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('#send').click();await page.waitForFunction(()=>!busy&&selected.length===0);
  const archived=[...preview.archive.records.values()].find(r=>r.id!==record.id);assert.ok(archived);
  const archivedBytes=archived.driveId?preview.remote.get(archived.driveId).bytes:fs.readFileSync(preview.archive.localPath(archived));
  assert.deepEqual(archivedBytes,Buffer.from(expected));
  assert.deepEqual(external,[],'no external face analysis requests');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,pixels,natural,bright}));
 } finally {if(browser)await browser.close();await preview.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
