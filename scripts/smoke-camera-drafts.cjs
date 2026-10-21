// 폰 화면의 미등록 사진 진입 → 개별/전체 삭제 → IndexedDB 재접속 복원.
// 실제 사진 표출·Google·이메일 전송은 하지 않는다.
const {chromium}=require('../host/node_modules/@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startPreview}=require('./camera-preview.cjs');
(async()=>{
 const preview=await startPreview();let browser;
 try{
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const image=fs.readFileSync(preview.photo);
  fs.mkdirSync('output',{recursive:true});
  const file=name=>({name,mimeType:'image/png',buffer:image});
  const add=async files=>{await page.locator('#galleryInput').setInputFiles(files);await page.locator('#review').waitFor();await page.evaluate(()=>draftChain);};
  const home=async()=>{await page.locator('#home').click();await page.locator('#captureHome').waitFor();};
  const empty=async()=>{
   await page.locator('#captureHome').waitFor();
   assert.equal(await page.locator('#resume').isVisible(),false,'empty drafts immediately remove the home entry');
   assert.equal(await page.locator('#notice').isVisible(),false,'no stale restored/failed draft notice remains');
   assert.equal(await page.locator('#galleryInput').inputValue(),'','the same album photo can be selected again');
   await home();assert.equal(await page.locator('#resume').isVisible(),false);
   await page.evaluate(()=>draftChain);await page.reload();await page.locator('#captureHome').waitFor();
   assert.equal(await page.locator('#resume').isVisible(),false,'deleted drafts do not return after reload');
  };
  await page.goto(preview.url+'/camera');await page.locator('#captureHome').waitFor();
  await add([file('첫 사진.png'),file('둘째 사진.png')]);await page.reload();await page.locator('#resume').waitFor();
  assert.equal(await page.locator('#draftCount').textContent(),'아직 올리지 않은 사진 2장');
  assert.equal(await page.locator('#notice').isVisible(),false,'restoration has a single actionable entry');
  for(const width of [320,390]){
   await page.setViewportSize({width,height:844});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const box=await page.locator('#continueResume').boundingBox();assert.ok(box.height>=44&&box.y+box.height<844);
  }
  await page.screenshot({path:'output/camera-drafts-home.png',fullPage:true});
  await page.locator('#continueResume').tap();await page.locator('#review').waitFor();
  await page.setViewportSize({width:320,height:568});
  const remove=page.getByRole('button',{name:'첫 사진.png 삭제',exact:true});
  assert.equal(await remove.isVisible(),true,'individual deletion is outside collapsed metadata');
  assert.ok((await remove.boundingBox()).height>=44,'phone deletion has a touch-sized target');
  assert.equal(await page.locator('.photoDetails[open]').count(),0);
  await page.screenshot({path:'output/camera-drafts-review.png',fullPage:true});
  await remove.tap();assert.equal(await page.locator('.photoCard').count(),1);
  await home();assert.equal(await page.locator('#draftCount').textContent(),'아직 올리지 않은 사진 1장');
  await page.evaluate(()=>draftChain);await page.reload();await page.locator('#continueResume').tap();
  assert.equal(await page.locator('.photoCard').count(),1);
  assert.equal(await page.locator('.photoCard img').getAttribute('alt'),'둘째 사진.png');
  await page.getByRole('button',{name:'둘째 사진.png 삭제',exact:true}).tap();await empty();

  await add([file('전체 삭제 1.png'),file('전체 삭제 2.png')]);
  page.once('dialog',d=>d.dismiss());await page.locator('#discard').tap();
  assert.equal(await page.locator('.photoCard').count(),2,'cancelling whole-list deletion keeps the photos');
  page.once('dialog',d=>{assert.match(d.message(),/휴대폰 앨범과 이미 등록한 사진은 삭제하지 않습니다/);d.accept();});
  await page.locator('#discard').tap();await empty();

  const chooser=page.waitForEvent('filechooser');await page.locator('#shoot').tap();await(await chooser).setFiles(preview.photo);
  await page.locator('#review').waitFor();await page.locator('.photoRemove').tap();await empty();
  assert.equal(await page.evaluate(()=>beautyWarmup.cached),null,'deleting the last captured photo releases skin preparation');
  assert.equal(await page.evaluate(()=>beautyWarmCandidate),null);

  // 서버 응답이 불확실한 사진은 단순 미등록으로 단정하지 않고 목록만 정리한다.
  // 원본 전송 대기는 별도 데이터이며 삭제 동작에서 건드리지 않는다.
  await add([file('응답 확인 필요.png')]);
  await page.evaluate(()=>{
   selected[0].submission={mode:'both'};
   originals=[{id:'waiting-original',key:'o:waiting-original',file:selected[0].file,error:'전송 대기'}];
   notice('응답을 확인하지 못한 사진을 확인해 주세요.',true,'draft');
   renderReview();renderOriginals();persistDraft();
  });
  await home();assert.match(await page.locator('#draftCount').textContent(),/등록 확인이 필요한 사진 1장/);
  await page.locator('#continueResume').tap();
  page.once('dialog',d=>d.dismiss());await page.locator('.photoRemove').tap();assert.equal(await page.locator('.photoCard').count(),1);
  page.once('dialog',d=>{assert.match(d.message(),/이미 등록한 사진은 취소되지 않습니다/);d.accept();});
  await page.locator('.photoRemove').tap();await page.locator('#captureHome').waitFor();
  assert.equal(await page.locator('#notice').isVisible(),false,'the resolved draft warning is removed');
  assert.equal(await page.locator('#draftCount').textContent(),'등록한 사진의 원본 전송 1장');
  await page.locator('#continueResume').tap();await page.locator('#statusDialog').waitFor();
  assert.equal(await page.locator('#originalTransferList p').count(),1,'deleting drafts preserves pending originals');
  await page.locator('[data-close-dialog="statusDialog"]').tap();await page.locator('#statusDialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{originals=[];renderOriginals();persistDraft();});

  // 알림을 일괄 지워서 네트워크 오류까지 숨기지 않는다.
  await add([file('연결 오류.png')]);await page.evaluate(()=>notice('인터넷 연결을 확인해 주세요.',true));
  await page.locator('.photoRemove').tap();assert.equal(await page.locator('#notice').textContent(),'인터넷 연결을 확인해 주세요.');
  assert.equal(preview.published.length,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,mobileWidths:[320,390],directEntry:true,individualDelete:true,bulkConfirm:true,reloadConsistent:true,originalsPreserved:true,noUploads:true}));
 }finally{await browser?.close();await preview.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
