// 초보자 기본 경로와 개인 행사 → 관리자 공통 행사 우선순위. 실제 결제·외부 전송 없음.
const {chromium}=require('../host/node_modules/@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {startPreview}=require('./camera-preview.cjs');
(async()=>{
 const preview=await startPreview();let browser,releaseConfig;const errors=[],models=[];
 const target=id=>({year:'2026',yearId:'year-2026',eventId:id});
 try{
  await preview.currentEvent.set(target('event-2026'));
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{if(r.url().includes('/vendor/mediapipe/'))models.push(r.url());});
  const capture=async p=>{const chooser=p.waitForEvent('filechooser');await p.locator('#shoot').click();await(await chooser).setFiles(preview.photo);await p.locator('#review').waitFor();};
  const close=async(p,id)=>{await p.locator('[data-close-dialog="'+id+'"]').click();await p.locator('#'+id).waitFor({state:'hidden'});};
  await page.goto(preview.url+'/camera');await page.locator('#shoot').waitFor();
  assert.equal(await page.locator('#purpose').isVisible(),false);assert.equal(await page.locator('#setup').isVisible(),false);assert.equal(await page.locator('#cameraInstall').isVisible(),false);
  assert.match(await page.locator('#quickEvent').textContent(),/공통.*목자/);assert.equal(await page.evaluate(()=>storage.get('lastTarget')),null);
  for(const width of [320,390]){await page.setViewportSize({width,height:844});const button=await page.locator('#shoot').boundingBox();assert.ok(button.y+button.height<844);assert.ok(button.height>=160);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.screenshot({path:'output/camera-flow-home.png',fullPage:true});
  await capture(page);assert.equal(await page.locator('#beautyDialog').isVisible(),false,'editing is optional');assert.equal(preview.published.length,0);
  await page.setViewportSize({width:320,height:568});const sendBox=await page.locator('#send').boundingBox();assert.ok(sendBox.y+sendBox.height<=568,'the primary register button fits a small phone');await page.setViewportSize({width:390,height:844});
  const retake=page.waitForEvent('filechooser');await page.locator('#reviewRetake').click();await(await retake).setFiles(preview.photo);await page.locator('#review').waitFor();assert.equal(await page.evaluate(()=>selected.length),1,'retake replaces the previous photo without another setup');
  await preview.currentEvent.set(target('event-newest'));await page.waitForFunction(()=>config.currentEvent?.eventId==='event-newest');assert.equal(await page.evaluate(()=>settings.target.eventId),'event-2026','a common-event change preserves the photo currently being reviewed');
  await page.screenshot({path:'output/camera-flow-review.png',fullPage:true});
  await page.locator('#send').click();await page.locator('#registrationDialog').waitFor();assert.equal(preview.published.length,0);
  await close(page,'registrationDialog');assert.equal(preview.published.length,0,'closing first-time registration never publishes');
  await page.locator('#send').click();await page.locator('#registrationName').fill('첫 등록자');await page.locator('#registrationSite').selectOption('screen');
  const configGate=new Promise(resolve=>releaseConfig=resolve);let refreshStarted;const started=new Promise(resolve=>refreshStarted=resolve);
  await page.route('**/live/api/camera/config',async route=>{refreshStarted();await configGate;await route.continue().catch(()=>{});});
  await page.evaluate(()=>{refreshSites();});await started;
  await page.route('**/live/api/camera/uploads',async route=>{const response=await route.fetch(),data=await response.json();for(const r of data.uploads)r.delivery=[];await route.fulfill({json:data});});
  await page.locator('#confirmRegistration').click();await page.waitForFunction(()=>!busy&&!selected.length&&!originals.length);await page.locator('#completePanel').waitFor();
  assert.match(await page.locator('#completeState').textContent(),/확인 중/,'server receipt is not a display receipt');
  releaseConfig();await page.unrouteAll({behavior:'wait'});await page.locator('#showStatus').click();await page.locator('#refreshHistory').click();await page.waitForFunction(()=>el('completeState').textContent.includes('확인했습니다'));await close(page,'statusDialog');
  await preview.archive.cycle(true);const first=[...preview.archive.records.values()][0];assert.equal(first.target.eventId,'event-2026');assert.deepEqual(preview.remote.get(first.driveId).bytes,fs.readFileSync(preview.photo));
  assert.equal(await page.evaluate(()=>storage.get('lastTarget')),null,'inherited common event never becomes a personal choice');
  const chooser=page.waitForEvent('filechooser');await page.locator('#nextCapture').click();await(await chooser).setFiles({name:'next.png',mimeType:'image/png',buffer:fs.readFileSync(preview.photo)});await page.locator('#review').waitFor();await page.locator('#send').click();await page.waitForFunction(()=>!busy&&!selected.length&&!originals.length);assert.equal(await page.locator('#registrationDialog').isVisible(),false,'name and screen are remembered');assert.equal(preview.published.length,2);
  await preview.currentEvent.set(target('event-newest'));await page.waitForFunction(()=>settings.target?.eventId==='event-newest');assert.equal(await page.evaluate(()=>settings.targetSource),'common');
  await page.locator('#quickEvent').click();await page.locator('#chooseFolder').click();await page.locator('[data-folder-id="event-old"]').click();await page.locator('#folderDialog').waitFor({state:'hidden'});await page.locator('#saveLocation').click();await page.locator('#locationDialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>storage.get('lastTarget').eventId),'event-old');await page.reload();await page.locator('#shoot').waitFor();assert.equal(await page.evaluate(()=>settings.target.eventId),'event-old','personal event wins on restart');
  await page.locator('#quickMonitor').click();await page.locator('[data-site-id="offline"]').click();await page.locator('#siteDialog').waitFor({state:'hidden'});assert.match(await page.locator('#quickMonitor').textContent(),/연결 끊김/);assert.equal(await page.evaluate(()=>settings.siteId),'offline');
  const fresh=await browser.newContext(),newPhone=await fresh.newPage();newPhone.on('pageerror',e=>errors.push(e.message));await newPhone.goto(preview.url+'/camera');await newPhone.locator('#shoot').waitFor();assert.equal(await newPhone.evaluate(()=>settings.target.eventId),'event-newest');await fresh.close();
  await preview.currentEvent.set(null);const empty=await browser.newContext({viewport:{width:390,height:844}}),noEvent=await empty.newPage();noEvent.on('pageerror',e=>errors.push(e.message));await noEvent.goto(preview.url+'/camera');await noEvent.locator('#galleryInput').setInputFiles(preview.photo);await noEvent.locator('#send').click();await noEvent.locator('#registrationName').fill('행사 미지정');await noEvent.locator('#registrationSite').selectOption('screen');await noEvent.locator('#confirmRegistration').click();await noEvent.waitForFunction(()=>!busy&&!selected.length&&!originals.length);await noEvent.locator('#locationNotice').waitFor();
  const waiting=[...preview.archive.records.values()].find(r=>r.status==='awaiting_target');assert.ok(waiting,'unassigned originals wait privately and do not block screen registration');
  await noEvent.locator('#locationNotice').click();await noEvent.locator('#chooseFolder').click();await noEvent.locator('[data-folder-id="event-newest"]').click();await noEvent.locator('#folderDialog').waitFor({state:'hidden'});await noEvent.locator('#saveLocation').click();await noEvent.locator('#locationDialog').waitFor({state:'hidden'});await preview.archive.cycle(true);assert.equal(preview.archive.records.get(waiting.id).target.eventId,'event-newest');assert.equal(preview.archive.records.get(first.id).target.eventId,'event-2026','assigning waiting photos never moves already assigned originals');
  // 실제 관리자 패널 마크업 + 실제 설정 API. 다른 관리 기능은 이 시나리오와 독립이다.
  const index=fs.readFileSync(require('node:path').join(__dirname,'../host/public/index.html'),'utf8'),start=index.indexOf('<div class="panel" id="currentCameraEventPanel">'),end=index.indexOf('<span class="panel-title">현재 라이브 현황</span>',start),panel=index.slice(start,index.lastIndexOf('<div class="panel">',end));
  const admin=await browser.newPage();admin.on('pageerror',e=>errors.push(e.message));await admin.route('**/current-event-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'+panel+'<script src="/camera-default-event-admin.js"></script>'}));await admin.goto(preview.url+'/current-event-test');await admin.locator('#currentEventFolder').selectOption('event-name-a');await admin.locator('#saveCurrentEvent').click();await admin.waitForFunction(()=>document.getElementById('currentEventSummary').textContent.includes('가족예배'));assert.equal(preview.currentEvent.get().eventId,'event-name-a');
  await admin.locator('#clearCurrentEvent').click();await admin.waitForFunction(()=>document.getElementById('currentEventSummary').textContent.includes('미지정'));assert.equal(preview.currentEvent.get(),null);
  await noEvent.locator('#home').click();await noEvent.locator('#archiveOnly').click();assert.equal(await noEvent.locator('#setup').isVisible(),false,'the quick archive branch also starts with capture');assert.equal(await noEvent.evaluate(()=>mode),'archive');
  await noEvent.locator('#galleryInput').setInputFiles({name:'archive-branch.png',mimeType:'image/png',buffer:fs.readFileSync(preview.photo)});await noEvent.locator('#send').click();await noEvent.waitForFunction(()=>!busy&&!selected.length);assert.equal(preview.published.length,3,'archive branch never publishes to the monitor');await noEvent.locator('#completePanel').waitFor();
  assert.deepEqual(errors,[]);assert.deepEqual(models,[],'the basic flow loads no face model');
  console.log(JSON.stringify({ok:true,published:preview.published.length,personalPriority:true,commonFallback:true,noEventStillRegisters:true,adminPanel:true,originalsPreserved:true}));
 }finally{releaseConfig?.();if(browser)await browser.close();await preview.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
