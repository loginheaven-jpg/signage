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
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(preview.url)&&!r.url().startsWith('blob:')&&!r.url().startsWith('data:'))external.push(r.url());});
  await page.goto(preview.url+'/camera');
  await page.locator('[data-mode=both]').click();await page.locator('#uploader').fill('피부보정 검증');
  await page.locator('#chooseSite').click();await page.locator('[data-site-id=screen]').click();await page.locator('#siteDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  const face=fs.readFileSync(require('node:path').join(__dirname,'../tests/fixtures/beauty-portrait.jpg'));
  await page.locator('#shootInput').setInputFiles({name:'portrait.jpg',mimeType:'image/jpeg',buffer:face});
  await page.locator('#beautyDialog').waitFor();
  assert.equal(await page.evaluate(()=>selected.length),1);
  await page.locator('[data-beauty-level="1"]').click();
  await page.waitForFunction(()=>!beautyProcessing && beautyPrepared,{timeout:60000});
  const pixels=await page.evaluate(()=>{
   const {source,smooth,alpha}=beautyPrepared;
   const output=CameraBeauty.paint(beautyPrepared,1).getContext('2d').getImageData(0,0,source.width,source.height).data;
   let changed=0,outside=0,smoothed=0;
   for(let i=0;i<output.length;i+=4){
    const different=output[i]!==source.data[i]||output[i+1]!==source.data[i+1]||output[i+2]!==source.data[i+2];
    if(different){changed++;if(!alpha[i+3])outside++;}
    if(alpha[i+3]&&(smooth[i]!==source.data[i]||smooth[i+1]!==source.data[i+1]))smoothed++;
   }
   return {changed,outside,smoothed,faces:beautyPrepared.faces};
  });
  assert.ok(pixels.faces>=1);assert.ok(pixels.changed>1000);assert.ok(pixels.smoothed>1000);assert.equal(pixels.outside,0,'background and excluded features remain unchanged');
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyOriginal').isVisible(),true);
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyCanvas').isVisible(),true);
  await page.screenshot({path:require('node:path').join(__dirname,'../output/camera-beauty-mobile.png')});
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  let natural=await page.evaluate(()=>selected[0].beautyFile.size);assert.ok(natural>1000);
  await page.reload();await page.locator('#continueResume').click();
  assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),natural);
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),1);
  // 기존 저장 키를 덮어써도 재접속 뒤 예전 보정으로 돌아가지 않는다.
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared,{timeout:60000});
  await page.locator('[data-beauty-level="2"]').click();await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  const bright=await page.evaluate(()=>selected[0].beautyFile.size);assert.notEqual(bright,natural);
  await page.reload();await page.locator('#continueResume').click();assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),bright);
  await page.locator('#send').click();await page.waitForFunction(()=>!busy&&selected.length===0);
  await page.waitForFunction(()=>originals.length===0);
  assert.equal(preview.published.length,1);
  assert.equal(preview.archive.records.size,1);
  const record=[...preview.archive.records.values()][0];
  assert.deepEqual(fs.readFileSync(preview.archive.localPath(record)),face);
  // 얼굴이 없는 사진에서는 보정으로 위장하지 않고 원본으로 진행한다.
  await page.locator('#galleryInput').setInputFiles(preview.photo);await page.locator('.beautyEdit').click();
  await page.locator('[data-beauty-level="1"]').click();await page.waitForFunction(()=>!beautyProcessing);
  assert.ok((await page.locator('#beautyState').textContent()).includes('얼굴을 찾지 못했습니다'));
  assert.equal(await page.locator('#applyBeauty').isEnabled(),true);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>selected[0].beautyFile),null);
  // 보정을 원본으로 되돌리면 저장된 보정 파일도 제거한다.
  await page.locator('#discard').click();
  await page.locator('#galleryInput').setInputFiles({name:'restore.jpg',mimeType:'image/jpeg',buffer:face});
  await page.locator('.beautyEdit').click();await page.locator('[data-beauty-level="1"]').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  await page.locator('[data-beauty-level="0"]').click();await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.reload();await page.locator('#continueResume').click();assert.equal(await page.evaluate(()=>!!selected[0].beautyFile),false);
  // 교회폴더 저장 전용에서도 보정본을 전송한다.
  await page.locator('#discard').click();await page.locator('#home').click();await page.locator('[data-mode="archive"]').click();
  await page.locator('#chooseFolder').click();await page.locator('[data-folder-id="event-2026"]').click();await page.locator('#folderDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  await page.locator('#galleryInput').setInputFiles({name:'archive.jpg',mimeType:'image/jpeg',buffer:face});await page.locator('.beautyEdit').click();
  await page.locator('[data-beauty-level="1"]').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  const expected=await page.evaluate(async()=>{const file=await CameraBeauty.file(beautyPrepared,1,beautyEntry.file);return Array.from(new Uint8Array(await file.arrayBuffer()));});
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
