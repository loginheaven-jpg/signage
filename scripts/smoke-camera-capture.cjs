const cameraUI=require('./helpers/camera-ui.cjs');
// 안드로이드 촬영: 기본은 항상 폰 카메라 앱이다. 카메라 앱을 오가다 메모리 부족으로 화면이 다시 열려
// 사진을 받지 못하면, 다시 촬영·보조카메라(화면 안 카메라)·앨범 단추를 바로 보여 준다.
// Chromium의 가짜 카메라와 안드로이드 사용자 에이전트를 쓴다. 로컬 가짜 Drive·모니터만 쓴다.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startPreview } = require('./camera-preview.cjs');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

(async () => {
  const preview = await startPreview();
  const browsers = [];
  // 같은 사진은 대기 목록에서 한 번만 받으므로 매번 다른 이름의 사진을 고른다.
  let copies = 0;
  const photo = () => { const file = path.join(preview.root, 'capture-' + (++copies) + '.png'); fs.copyFileSync(preview.photo, file); return file; };
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
      return { page, errors };
    };
    const watchNative = page => page.evaluate(() => { window.nativeOpened = []; for (const id of ['shootInput', 'videoInput', 'galleryInput']) document.getElementById(id).addEventListener('click', () => window.nativeOpened.push(id)); });
    // 폰 카메라 앱·앨범을 다녀오는 사이 휴대폰이 화면을 다시 연 상황
    const reopenedWhile = async (page, input) => {
      await page.evaluate(id => localStorage.setItem('camera.capturePending', JSON.stringify(id)), input);
      await page.reload(); await page.locator('#work').waitFor(); await page.locator('#notice .noticeActions').waitFor();
      await watchNative(page);
    };
    const buttons = page => page.locator('#notice .noticeActions button').allTextContents();

    const { page, errors } = await open(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ['camera']);
    // 1. "촬영하기" always uses the phone's camera app.
    await watchNative(page);
    const chooser = page.waitForEvent('filechooser');
    await cameraUI.click(page, '#shoot');
    await (await chooser).setFiles(photo());
    await page.waitForFunction(() => selected.length === 1);
    assert.deepEqual(await page.evaluate(() => window.nativeOpened), ['shootInput']);
    assert.equal(await page.locator('#cameraDialog').isHidden(), true, 'the in-page camera is not the default');
    assert.equal(await page.evaluate(() => localStorage.getItem('camera.capturePending')), 'false', 'a delivered photo clears the pending mark');

    // 2. The page was reopened while the camera app was open: the notice shows even with photos waiting.
    await reopenedWhile(page, 'shootInput');
    assert.match(await page.locator('#notice').textContent(), /메모리가 부족해.*방금 찍은 사진을 받지 못했습니다.*보조카메라/s);
    assert.deepEqual(await buttons(page), ['다시 촬영', '보조카메라로 찍기']);
    // "다시 촬영" goes back to the phone camera app.
    const again = page.waitForEvent('filechooser');
    await page.locator('#notice .noticeActions button', { hasText: '다시 촬영' }).click();
    await (await again).setFiles(photo());
    await page.waitForFunction(() => selected.length === 2);
    assert.deepEqual(await page.evaluate(() => window.nativeOpened), ['shootInput']);

    // 3. "보조카메라로 찍기" takes the photo inside the page, so nothing can be lost on the way back.
    await reopenedWhile(page, 'shootInput');
    await page.locator('#notice .noticeActions button', { hasText: '보조카메라로 찍기' }).click();
    await page.locator('#cameraDialog').waitFor();
    assert.equal(await page.locator('#cameraTitle').textContent(), '보조카메라');
    await page.waitForFunction(() => document.getElementById('cameraVideo').videoWidth > 0);
    const box = await page.locator('#cameraDialog').boundingBox();
    assert.ok(box.width >= 389 && box.height >= 843, 'the aux camera fills the phone screen');
    if (process.env.CAPTURE_SHOT) await page.screenshot({ path: process.env.CAPTURE_SHOT });   // 화면 확인용
    await page.locator('#flipCamera').click();
    await page.waitForFunction(() => document.getElementById('cameraVideo').classList.contains('mirrored') && document.getElementById('cameraVideo').videoWidth > 0);
    await page.locator('#snap').click();
    await page.locator('#cameraDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => selected.length === 3);
    assert.deepEqual(await page.evaluate(() => window.nativeOpened), [], 'the phone camera app was not used');
    const shot = await page.evaluate(() => ({ type: selected.at(-1).file.type, size: selected.at(-1).file.size, source: selected.at(-1).dateSource }));
    assert.equal(shot.type, 'image/jpeg'); assert.ok(shot.size > 1000); assert.equal(shot.source, 'capture');
    assert.equal(await page.evaluate(() => !!cameraStream), false, 'the camera is released after the shot');
    await page.reload(); await page.locator('#work').waitFor();
    await page.waitForFunction(() => selected.length === 3);
    assert.equal(await page.locator('#notice .noticeActions').count(), 0, 'no lost-photo notice after an aux camera shot');
    // A video recorded in the camera app has no aux camera; a gallery pick says the gallery is untouched.
    await reopenedWhile(page, 'videoInput');
    assert.deepEqual(await buttons(page), ['다시 촬영']);
    await reopenedWhile(page, 'galleryInput');
    assert.match(await page.locator('#notice').textContent(), /갤러리의 사진은 그대로 있습니다/);
    assert.deepEqual(await buttons(page), ['갤러리에서 다시 고르기']);
    assert.deepEqual(errors, []);

    // 4. Without camera permission the aux camera cannot open; the phone camera stays one tap away.
    const denied = await open([], []);
    await reopenedWhile(denied.page, 'shootInput');
    await denied.page.locator('#notice .noticeActions button', { hasText: '보조카메라로 찍기' }).click();
    await denied.page.waitForFunction(() => document.getElementById('notice').textContent.includes('보조카메라를 열지 못했습니다'));
    assert.deepEqual(await buttons(denied.page), ['다시 촬영']);
    const retry = denied.page.waitForEvent('filechooser');
    await denied.page.locator('#notice .noticeActions button', { hasText: '다시 촬영' }).click();
    await (await retry).setFiles(photo());
    await denied.page.waitForFunction(() => selected.length === 1);
    assert.deepEqual(denied.errors, []);
    console.log('Chromium Android capture passed: the phone camera app stays the default; when the page reopens and the photo is lost the notice shows even with photos waiting and offers retake and aux camera (gallery only for an interrupted gallery pick); the aux camera fills the screen, flips, stores the shot before anything else; denied permission falls back to the camera app.');
  } finally {
    for (const browser of browsers) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
