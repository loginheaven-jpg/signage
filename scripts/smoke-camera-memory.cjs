const cameraUI=require('./helpers/camera-ui.cjs');
// 촬영 중 메모리 줄이기: 검토 목록은 작은 미리보기만 쓰고, 카메라 앱을 열기 전에 이미지 요소를 거두며,
// 전송 축소는 원본을 통째로 풀지 않고, 연속 촬영·저사양 기기에서는 뽀샤시 미리 준비를 쉰다. 로컬 가짜 Drive·모니터만 쓴다.
const { chromium } = require('../host/node_modules/@playwright/test');
const sharp = require('../host/node_modules/sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview();
  let browser;
  try {
    // 폰 사진처럼 큰 원본(3000×2000). 미리보기는 이보다 훨씬 작아야 한다.
    const big = path.join(preview.root, 'big.jpg');
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 90, g: 120, b: 80 } } }).jpeg({ quality: 95 }).toFile(big);
    const originalBytes = fs.statSync(big).size;
    const photos = [1, 2, 3].map(i => { const file = path.join(preview.root, 'big-' + i + '.jpg'); fs.copyFileSync(big, file); return file; });
    browser = await chromium.launch({ headless: true });
    const spy = () => {
      window.bitmapCalls = [];
      const real = window.createImageBitmap;
      window.createImageBitmap = (source, options) => { window.bitmapCalls.push({ blob: source instanceof Blob, resize: options?.resizeWidth || options?.resizeHeight || 0 }); return real(source, options); };
    };
    const open = async (init, mode) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.addInitScript(spy); if (init) await page.addInitScript(init);
      await page.goto(preview.url + '/camera');
      await cameraUI.click(page, '#home'); await page.locator('#captureHome').waitFor();
      await cameraUI.click(page, '[data-mode=' + mode + ']'); await cameraUI.fill(page, '#uploader', '김예봄');
      await cameraUI.click(page, '#chooseSite'); await page.locator('#siteDialog').waitFor();
      await cameraUI.click(page, '[data-site-id=screen]'); await page.locator('#siteDialog').waitFor({ state: 'hidden' });
      await cameraUI.click(page, '#useSettings'); await page.locator('#work').waitFor();
      return { page, errors };
    };

    const { page, errors } = await open(null, 'live');
    // 1. The review list shows small previews, decoded at a reduced size, never the originals.
    await page.locator('#galleryInput').setInputFiles(photos);
    await page.waitForFunction(() => selected.length === 3 && !document.getElementById('review').hidden);
    const thumbs = await page.evaluate(() => selected.map(r => r.thumb?.size || 0));
    assert.ok(thumbs.every(size => size > 0 && size < originalBytes / 10), 'thumbnails are a small fraction of the originals: ' + thumbs + ' vs ' + originalBytes);
    assert.ok((await page.evaluate(() => window.bitmapCalls)).every(call => call.resize && call.resize <= 800), 'thumbnails are decoded at a reduced size');
    await page.waitForFunction(() => [...document.querySelectorAll('#selectedPhotos img')].every(img => img.complete && img.naturalWidth > 0));
    const widths = await page.locator('#selectedPhotos img').evaluateAll(imgs => imgs.map(img => img.naturalWidth));
    assert.deepEqual(widths, [800, 800, 800], 'the list draws the previews, not the 3000px originals');

    // 2. Leaving the review (to add another photo) removes the images and their URLs; coming back redraws from the kept previews.
    await page.evaluate(() => { window.bitmapCalls = []; });
    await cameraUI.click(page, '#reviewAdd');
    await page.waitForFunction(() => document.getElementById('review').hidden);
    assert.equal(await page.locator('#selectedPhotos img').count(), 0);
    assert.equal(await page.evaluate(() => selected.every(r => !r.url)), true, 'display URLs are revoked while the camera may be in front');
    await cameraUI.click(page, '#continueResume');
    await page.waitForFunction(() => !document.getElementById('review').hidden && document.querySelectorAll('#selectedPhotos img').length === 3);
    assert.equal(await page.evaluate(() => window.bitmapCalls.length), 0, 'no photo is decoded again when returning');

    // 3. After the page reopens, previews come from the phone's storage instead of decoding the originals again.
    await page.reload(); await page.locator('#work').waitFor();
    await cameraUI.click(page, '#continueResume');
    await page.waitForFunction(() => document.querySelectorAll('#selectedPhotos img').length === 3);
    assert.equal(await page.evaluate(() => selected.every(r => r.thumb) && window.bitmapCalls.length === 0), true);

    // 4. Sending decodes each original at a reduced size, and the share copies are swapped for the stored ones before the camera opens.
    await page.evaluate(() => { window.bitmapCalls = []; });
    await cameraUI.click(page, '#send');
    await page.waitForFunction(() => !busy && document.querySelector('#progress').textContent.includes('서버 접수 완료'));
    const sendCalls = await page.evaluate(() => window.bitmapCalls);
    assert.equal(sendCalls.length, 3); assert.ok(sendCalls.every(call => call.resize && call.resize <= 2048), 'display copies are made from a reduced decode: ' + JSON.stringify(sendCalls));
    assert.equal(preview.published.length, 3);
    await page.evaluate(async () => { window.beforeOffload = shareBatch.photos.map(p => p.file); await offloadShareBatch(); });
    assert.equal(await page.evaluate(() => shareBatch.photos.every((p, i) => p.file !== window.beforeOffload[i] && p.file.size === window.beforeOffload[i].size)), true, 'share copies now point at the stored files');
    assert.deepEqual(errors, []);

    // 5. Two captures in a row without opening the editor stop the speculative preparation; a 4 GB phone never starts it.
    const low = await open(() => { Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 }); }, 'live');
    await low.page.locator('#shootInput').setInputFiles(photos[0]);
    await low.page.waitForFunction(() => selected.length === 1);
    assert.equal(await low.page.evaluate(() => beautyWarmup.cached === null && beautyWarmCandidate === null && !storage.get('warmStreak')), true, 'no preparation on a low-memory phone');
    // Losing a photo to the camera app also tells the photographer about the camera's 12MP mode.
    await low.page.evaluate(() => localStorage.setItem('camera.capturePending', JSON.stringify('shootInput')));
    await low.page.reload(); await low.page.locator('#notice .noticeActions').waitFor();
    assert.match(await low.page.locator('#notice').textContent(), /12MP 기본 모드/);
    assert.deepEqual(low.errors, []);
    console.log('Chromium capture memory passed: review list uses 800px previews decoded at reduced size, leaving the review drops images and URLs and returning redraws without decoding, previews survive a reload, sending decodes originals at reduced size and share copies move to storage, low-memory phones skip preparation, lost-photo notice mentions 12MP.');
  } finally {
    if (browser) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
