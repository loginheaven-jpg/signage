// 실제 얼굴 모델과 로컬 Drive를 사용한다. 외부 모니터·메일·Drive에는 접속하지 않는다.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('../host/node_modules/sharp');
const { startPreview } = require('./camera-preview.cjs');
(async () => {
 const preview = await startPreview(); let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[], external=[];
  const setStrength=async value=>{await page.waitForFunction(()=>!beautyProcessing&&beautyBase);return page.locator('#beautyStrength').evaluate((slider,value)=>{slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));},value);};
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(preview.url)&&!r.url().startsWith('blob:')&&!r.url().startsWith('data:'))external.push(r.url());});
  await page.goto(preview.url+'/camera');
  await page.locator('[data-mode=both]').click();await page.locator('#uploader').fill('피부보정 검증');
  await page.locator('#chooseSite').click();await page.locator('[data-site-id=screen]').click();await page.locator('#siteDialog').waitFor({state:'hidden'});await page.locator('#useSettings').click();
  const face=fs.readFileSync(require('node:path').join(__dirname,'../tests/fixtures/beauty-portrait.jpg'));
  await page.locator('#shootInput').setInputFiles({name:'portrait.jpg',mimeType:'image/jpeg',buffer:face});
  await page.locator('#beautyDialog').waitFor();await page.waitForFunction(()=>!beautyProcessing&&beautyBase);
  assert.equal(await page.evaluate(()=>selected.length),1);
  const dedup=await page.evaluate(async()=>{
   const r={file:{name:'same.jpg',size:100,lastModified:1},beautyLevel:35,beautyFile:{size:80}};
   const s={target:{year:2026,folderName:'행사'},uploaderName:'검증',date:'2026-10-17T10:00'};
   const legacy=await archiveRequestId(r,s);r.photoEffects={color:'none',frame:'none'};const unchanged=await archiveRequestId(r,s);
   r.photoEffects.color='warm';const warm=await archiveRequestId(r,s);r.photoEffects.color='mono';const mono=await archiveRequestId(r,s);
   return {legacy,unchanged,warm,mono};
  });
  assert.equal(dedup.legacy,dedup.unchanged,'adding default effect metadata preserves archive deduplication');assert.notEqual(dedup.warm,dedup.mono,'different effects remain distinct even at equal file sizes');
  await page.evaluate(()=>{const prepare=CameraBeauty.prepare;window.beautyPrepareCalls=0;CameraBeauty.prepare=(...args)=>{window.beautyPrepareCalls++;return prepare(...args);};});
  await page.locator('#beautyStrength').press('End');
  await page.waitForFunction(()=>!beautyProcessing && beautyPrepared,{timeout:60000});
  assert.equal(await page.locator('#beautyStrength').inputValue(),'100','slider can initialize the face analysis');
  await setStrength(0);await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='0');
  assert.equal(await page.locator('#compareBeauty').isDisabled(),true);
  await setStrength(100);await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='100');
  await page.evaluate(()=>{
   const paint=CameraBeauty.paint;window.beautyPaintCalls=0;
   CameraBeauty.paint=(...args)=>{window.beautyPaintCalls++;return paint(...args);};
   const slider=document.querySelector('#beautyStrength');
   for(let value=40;value<=61;value++){slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='60');
  assert.equal(await page.evaluate(()=>window.beautyPaintCalls),1,'rapid slider events render once per frame');
  await setStrength(35);await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='35');
  const pixels=await page.evaluate(()=>{
   const {source,retouched,alpha}=beautyPrepared;
   const output=CameraBeauty.paint(beautyPrepared,35).getContext('2d').getImageData(0,0,source.width,source.height).data;
   let changed=0,outside=0,smoothed=0;
   for(let i=0;i<output.length;i+=4){
    const different=output[i]!==source.data[i]||output[i+1]!==source.data[i+1]||output[i+2]!==source.data[i+2];
    if(different){changed++;if(!alpha[i+3])outside++;}
    if(alpha[i+3]&&(retouched[i]!==source.data[i]||retouched[i+1]!==source.data[i+1]))smoothed++;
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
  assert.equal(await page.evaluate(()=>beautyPrepared.canvas===beautyBase),true,'face processing reuses the decoded photo');
  assert.equal(await page.evaluate(()=>beautyPrepared.smooth===undefined),true,'intermediate smoothing array is not retained');
  await page.evaluate(()=>{window.savedEditorCanvas=renderedBeauty();window.savedPaintPixels=beautyPrepared.pixels;});
  await page.locator('#colorTab').click();await page.locator('#skinTab').click();
  assert.equal(await page.evaluate(()=>renderedBeauty()===window.savedEditorCanvas),true,'tab changes reuse the composed canvas');
  const layout=await page.evaluate(()=>{
   const photo=document.querySelector('.beautyPreview').getBoundingClientRect(),slider=document.querySelector('.beautySlider').getBoundingClientRect(),compare=document.querySelector('#compareBeauty').getBoundingClientRect();
   return {photoHeight:photo.height,sliderRight:slider.right,compareLeft:compare.left,rowOffset:Math.abs((slider.top+slider.bottom-compare.top-compare.bottom)/2)};
  });
  assert.ok(layout.photoHeight>450,'phone preview is substantially larger than the old 304px image area');
  assert.ok(layout.sliderRight<layout.compareLeft);assert.ok(layout.rowOffset<5,'slider and comparison share one row');
  assert.equal(await page.locator('#toggleBeauty').count(),0,'duplicate on/off control removed');
  await page.locator('#colorTab').click();await page.locator('[data-photo-color="warm"]').click();
  await page.locator('#frameTab').click();await page.locator('[data-photo-frame="white"]').click();await page.locator('#skinTab').click();
  await page.waitForFunction(()=>document.querySelector('#beautyCanvas').getContext('2d').getImageData(0,0,1,1).data[0]===255);
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyOriginal').isVisible(),true);
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyCanvas').isVisible(),true);
  assert.equal(await page.evaluate(()=>beautyPrepared.pixels===window.savedPaintPixels),true,'painting reuses the pixel buffer');
  assert.equal(await page.locator('#beautyStrength').inputValue(),'35','comparison preserves the selected strength');
  assert.equal(await page.evaluate(()=>window.beautyPrepareCalls),1,'comparison does not rerun detection');
  await page.screenshot({path:require('node:path').join(__dirname,'../output/camera-beauty-mobile.png')});
  await page.evaluate(()=>{window.canvasesToRelease=[renderedBeauty(),beautyBase];window.editorAbortSignal=beautyAbort.signal;});
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#beautyOriginal').width===1);
  assert.equal(await page.locator('#beautyOriginal').evaluate(c=>c.width),1,'closing explicitly releases the original display canvas');
  assert.equal(await page.locator('#beautyCanvas').evaluate(c=>c.width),1,'closing explicitly releases the preview canvas');
  assert.equal(await page.evaluate(()=>window.canvasesToRelease.every(c=>c.width===1)),true,'closing frees native pixel surfaces even if JS references survive');
  assert.equal(await page.evaluate(()=>window.editorAbortSignal.aborted),true,'closing cancels remaining processing');
  let natural=await page.evaluate(()=>selected[0].beautyFile.size);assert.ok(natural>1000);
  await page.reload();await page.locator('#continueResume').click();
  assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),natural);
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),35);
  assert.deepEqual(await page.evaluate(()=>selected[0].photoEffects),{color:'warm',frame:'white'});
  // 이전 버전의 강도 1/2를 35/70으로 해석하고 저장한 원본은 유지한다.
  await page.evaluate(()=>{selected[0].beautyLevel=1;delete selected[0].beautyScale;});
  // 기존 저장 키를 덮어써도 재접속 뒤 예전 보정으로 돌아가지 않는다.
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared,{timeout:60000});
  assert.equal(await page.locator('#beautyStrength').inputValue(),'35','legacy preset migrated when reopening');
  await setStrength(70);await page.waitForFunction(()=>document.querySelector('#beautyStrength').value==='70');
  await page.locator('#beautyStrength').press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('#beautyStrengthValue').textContent==='65');
  assert.equal(await page.locator('#beautyStrength').getAttribute('step'),'5');
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  const bright=await page.evaluate(()=>selected[0].beautyFile.size);assert.notEqual(bright,natural);
  await page.reload();await page.locator('#continueResume').click();assert.equal(await page.evaluate(()=>selected[0].beautyFile.size),bright);
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),65);assert.equal(await page.evaluate(()=>selected[0].beautyScale),100);
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  assert.equal(await page.locator('#beautyStrength').inputValue(),'65');
  await page.locator('#beautyStrength').press('ArrowRight');await page.locator('#closeBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>selected[0].beautyLevel),65,'closing discards unsaved slider changes');
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
  await page.locator('.beautyEdit').click();await setStrength(50);await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  assert.equal(await page.locator('#beautyStrength').inputValue(),'50','slider directly selects skin strength');
  await setStrength(35);
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyPrepared);
  await setStrength(0);await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
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
  // 얼굴 없는 사진에도 색감과 프레임을 적용하고 저장·복원·전송한다.
  await page.locator('#galleryInput').setInputFiles(preview.photo);await page.locator('.beautyEdit').click();
  await page.evaluate(()=>{window.filterPrepareCalls=0;const prepare=CameraBeauty.prepare;CameraBeauty.prepare=(...args)=>{window.filterPrepareCalls++;return prepare(...args);};});
  await page.locator('#colorTab').click();await page.locator('[data-photo-color="warm"]').click();await page.waitForFunction(()=>!beautyProcessing&&beautyBase);
  for(const color of ['warm','pastel','film','mono']){
   await page.locator('[data-photo-color="'+color+'"]').click();
   await page.waitForFunction(color=>document.querySelector('[data-photo-color="'+color+'"]').getAttribute('aria-pressed')==='true',color);
   const pixel=await page.evaluate(()=>Array.from(document.querySelector('#beautyCanvas').getContext('2d').getImageData(400,300,1,1).data));
   assert.notDeepEqual(pixel.slice(0,3),[83,120,106]);
   if(color==='mono')assert.ok(pixel[0]===pixel[1]&&pixel[1]===pixel[2],'monochrome is actually gray');
  }
  await page.locator('[data-photo-color="warm"]').click();await page.locator('#frameTab').click();await page.locator('[data-photo-frame="polaroid"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-photo-frame="polaroid"]').getAttribute('aria-pressed')==='true');
  const composition=await page.evaluate(async()=>({width:renderedBeauty().width,height:renderedBeauty().height,corner:Array.from(renderedBeauty().getContext('2d').getImageData(0,0,1,1).data),bytes:Array.from(new Uint8Array(await (await CameraBeauty.exportPhoto(renderedBeauty(),beautyEntry.file)).arrayBuffer()))}));
  assert.ok(composition.width>1200&&composition.height>900);assert.deepEqual(composition.corner,[255,248,236,255]);
  assert.equal(await page.evaluate(()=>window.filterPrepareCalls),0,'color/frame do not require face detection');
  for(const frame of ['confetti','film']){
    await page.locator('[data-photo-frame="'+frame+'"]').click();
    await page.waitForFunction(frame=>document.querySelector('[data-photo-frame="'+frame+'"]').getAttribute('aria-pressed')==='true',frame);
    assert.equal(await page.evaluate(()=>renderedBeauty().width>beautyBase.width),true,'fun frame is included in the actual composed image');
  }
  await page.locator('[data-photo-frame="polaroid"]').click();await page.waitForFunction(()=>document.querySelector('[data-photo-frame="polaroid"]').getAttribute('aria-pressed')==='true');
  await page.locator('#compareBeauty').click();assert.equal(await page.locator('#beautyOriginal').isVisible(),true);
  assert.equal(await page.evaluate(()=>beautyEffects.color),'warm');await page.locator('#compareBeauty').click();
  for(const size of [{width:320,height:568},{width:390,height:844}]){
   await page.setViewportSize(size);
   assert.equal(await page.locator('#beautyDialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true);
   assert.equal(await page.locator('#applyBeauty').evaluate(b=>b.getBoundingClientRect().bottom<=innerHeight+1),true);
  }
  await page.screenshot({path:require('node:path').join(__dirname,'../output/camera-filters-mobile.png')});
  await page.locator('#frameTab').press('ArrowLeft');assert.equal(await page.locator('#colorTab').getAttribute('aria-selected'),'true');
  await page.locator('#colorTab').press('Home');assert.equal(await page.locator('#skinTab').getAttribute('aria-selected'),'true');
  await page.setViewportSize({width:844,height:390});await page.locator('#applyBeauty').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#applyBeauty').evaluate(b=>b.getBoundingClientRect().bottom<=innerHeight+1),true,'landscape still permits access to continue');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#applyBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.reload();await page.locator('#continueResume').click();
  assert.deepEqual(await page.evaluate(()=>selected[0].photoEffects),{color:'warm',frame:'polaroid'});assert.equal(await page.evaluate(()=>selected[0].beautyLevel),0);
  await page.locator('.beautyEdit').click();await page.waitForFunction(()=>!beautyProcessing&&beautyBase);
  assert.equal(await page.locator('#compareBeauty').isEnabled(),true);
  await page.locator('#closeBeauty').click();await page.locator('#beautyDialog').waitFor({state:'hidden'});
  await page.locator('#send').click();await page.waitForFunction(()=>!busy&&selected.length===0);
  const composedRecord=[...preview.archive.records.values()].find(r=>r.id!==record.id&&r.id!==archived.id);assert.ok(composedRecord);
  const composedBytes=composedRecord.driveId?preview.remote.get(composedRecord.driveId).bytes:fs.readFileSync(preview.archive.localPath(composedRecord));assert.deepEqual(composedBytes,Buffer.from(composition.bytes));
  const large=await sharp(Buffer.from('<svg width="4000" height="3000"><rect width="2000" height="1500" fill="red"/><rect x="2000" width="2000" height="1500" fill="green"/><rect y="1500" width="2000" height="1500" fill="blue"/><rect x="2000" y="1500" width="2000" height="1500" fill="yellow"/></svg>')).jpeg().withMetadata({orientation:6}).toBuffer();
  const decoded=await page.evaluate(async bytes=>{
    const bitmap=window.createImageBitmap;let resize;
    window.createImageBitmap=(file,options)=>{resize=options;return bitmap(file,options);};
    try{const canvas=await CameraBeauty.decode(new File([new Uint8Array(bytes)],'large.jpg',{type:'image/jpeg'}));const result={width:canvas.width,height:canvas.height,resize,pixel:Array.from(canvas.getContext('2d').getImageData(100,100,1,1).data)};canvas.width=canvas.height=1;return result;}
    finally{window.createImageBitmap=bitmap;}
  },[...large]);
  assert.equal(decoded.width,1536);assert.equal(decoded.height,2048);assert.equal(decoded.resize.resizeWidth,1536);assert.equal(decoded.resize.resizeHeight,2048);
  assert.ok(decoded.pixel[2]>200&&decoded.pixel[0]<40,'large JPEG preserves EXIF rotation when resizing');
  assert.equal(await page.locator('#skinTab').textContent(),'뽀샤시');
  assert.deepEqual(external,[],'no external face analysis requests');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,pixels,natural,bright}));
 } finally {if(browser)await browser.close();await preview.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
