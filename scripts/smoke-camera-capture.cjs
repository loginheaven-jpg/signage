const cameraUI=require('./helpers/camera-ui.cjs');
// 안드로이드 촬영: 폰 카메라 앱을 오가다 화면이 다시 열리며 사진을 잃지 않도록 화면 안 카메라로 찍는다.
// Chromium의 가짜 카메라와 안드로이드 사용자 에이전트를 쓴다. 로컬 가짜 Drive·모니터만 쓴다.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const { startPreview } = require('./camera-preview.cjs');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

(async () => {
  const preview = await startPreview();
  const browsers = [];
  try {
    const open = async (args, permissions) => {
      const browser = await chromium.launch({ headless: true, args }); browsers.push(browser);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ANDROID, isMobile: true, hasTouch: true, permissions });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.goto(preview.url + '/camera');
      await cameraUI.click(page, '#home'); await page.locator('#captureHome').waitFor();
      await cameraUI.click(page, '[data-mode=live]'); await cameraUI.fill(page, '#uploader', '김예봄');
      await cameraUI.click(page, '#chooseSite'); await page.locator('#siteDialog').waitFor();
      await cameraUI.click(page, '[data-site-id=screen]'); await page.locator('#siteDialog').waitFor({ state: 'hidden' });
      await cameraUI.click(page, '#useSettings'); await page.locator('#work').waitFor();
      await page.evaluate(() => { window.nativeOpened = []; for (const id of ['shootInput', 'videoInput', 'galleryInput']) document.getElementById(id).addEventListener('click', () => window.nativeOpened.push(id)); });
      return { page, errors };
    };

    // 1. With a camera: "촬영하기" opens the in-page camera instead of the phone's camera app.
    const { page, errors } = await open(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ['camera']);
    await cameraUI.click(page, '#shoot');
    await page.locator('#cameraDialog').waitFor();
    await page.waitForFunction(() => document.getElementById('cameraVideo').videoWidth > 0);
    assert.equal(await page.locator('#flipCamera').isVisible(), true);
    assert.equal(await page.locator('#nativeCamera').isVisible(), true);
    const box = await page.locator('#cameraDialog').boundingBox();
    assert.ok(box.width >= 389 && box.height >= 843, 'the camera fills the phone screen');
    if (process.env.CAPTURE_SHOT) await page.screenshot({ path: process.env.CAPTURE_SHOT });   // 화면 확인용
    await page.locator('#snap').click();
    await page.locator('#cameraDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => selected.length === 1);
    assert.deepEqual(await page.evaluate(() => window.nativeOpened), [], 'the phone camera app was not used');
    const shot = await page.evaluate(() => ({ type: selected[0].file.type, size: selected[0].file.size, source: selected[0].dateSource }));
    assert.equal(shot.type, 'image/jpeg'); assert.ok(shot.size > 1000); assert.equal(shot.source, 'capture');
    assert.equal(await page.evaluate(() => !!cameraStream), false, 'the camera is released after the shot');
    // The photo is already in the phone's waiting list, so the page being reopened does not lose it.
    await page.reload(); await page.locator('#work').waitFor();
    await page.waitForFunction(() => selected.length === 1);
    assert.equal(await page.locator('#notice').isVisible() && (await page.locator('#notice').textContent()).includes('받지 못했습니다'), false);
    // The front camera can be chosen; its preview is mirrored like a mirror.
    await cameraUI.click(page, '#shoot'); await page.locator('#cameraDialog').waitFor();
    await page.locator('#flipCamera').click();
    await page.waitForFunction(() => document.getElementById('cameraVideo').classList.contains('mirrored') && document.getElementById('cameraVideo').videoWidth > 0);
    await page.locator('#closeCamera').click(); await page.locator('#cameraDialog').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);

    // 2. Without camera permission: no silent failure; one button continues with the phone camera app.
    const denied = await open([], []);
    await cameraUI.click(denied.page, '#shoot');
    await denied.page.locator('#notice .noticeActions button', { hasText: '폰 카메라 앱으로 찍기' }).waitFor();
    assert.match(await denied.page.locator('#notice').textContent(), /카메라 권한을 허용하면/);
    const chooser = denied.page.waitForEvent('filechooser');
    await denied.page.locator('#notice .noticeActions button').click();
    await (await chooser).setFiles(preview.photo);
    await denied.page.waitForFunction(() => selected.length === 1);
    assert.deepEqual(await denied.page.evaluate(() => window.nativeOpened), ['shootInput']);

    // 3. If the page was reopened while the camera app was open, retrying is one tap away.
    await denied.page.evaluate(() => { localStorage.setItem('camera.capturePending', JSON.stringify('shootInput')); });
    await denied.page.reload(); await denied.page.locator('#work').waitFor();
    await denied.page.locator('#notice .noticeActions').waitFor();
    assert.match(await denied.page.locator('#notice').textContent(), /방금 찍은 사진을 받지 못했습니다/);
    assert.deepEqual(await denied.page.locator('#notice .noticeActions button').allTextContents(), ['다시 촬영', '앨범에서 고르기']);
    const album = denied.page.waitForEvent('filechooser');
    await denied.page.locator('#notice .noticeActions button', { hasText: '앨범에서 고르기' }).click();
    await (await album).setFiles(preview.photo);
    assert.equal(await denied.page.locator('#notice').isHidden(), true);
    // A photo picked from the album is not lost when the page reopens; the message says so.
    await denied.page.evaluate(() => { localStorage.setItem('camera.capturePending', JSON.stringify('galleryInput')); });
    await denied.page.reload(); await denied.page.locator('#notice .noticeActions').waitFor();
    assert.match(await denied.page.locator('#notice').textContent(), /앨범의 사진은 그대로 있습니다/);
    assert.deepEqual(denied.errors, []);
    console.log('Chromium Android capture passed: in-page camera fills the screen, the shot is stored before anything else and survives a reopened page, front camera switch, denied permission continues with the camera app in one tap, lost-photo notice offers retake and album.');
  } finally {
    for (const browser of browsers) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
