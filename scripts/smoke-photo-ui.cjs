// Real Chromium -> multipart API -> in-memory Drive -> rendered results.
// No production Google connection, email, or desktop clipboard changes.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview();
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(preview.url + '/camera');
    await page.locator('[data-mode=archive]').click();
    await page.locator('#uploader').fill('김예봄');
    await page.locator('#event').selectOption('event-2026');
    await page.locator('#useSettings').click();
    await page.locator('#galleryInput').setInputFiles(preview.photo);
    await page.locator('#review').waitFor({ state: 'visible' });
    await page.locator('#send').click();
    await page.getByText('같은 작업으로 계속 촬영하거나 사진을 선택하세요.', { exact: false }).waitFor({ state: 'attached' });
    assert.equal(preview.published.length, 0);
    await preview.archive.cycle(true); await page.locator('#refreshHistory').click();
    await page.getByText('Drive 보관 완료', { exact: true }).waitFor();
    assert.equal(preview.archive.records.size, 1);

    await page.locator('#changePurpose').click();
    await page.locator('[data-mode=both]').click();
    await page.locator('#year').fill('2027'); await page.locator('#year').press('Tab');
    await page.locator('#event').selectOption('__new__');
    await page.locator('#eventName').fill('신년감사예배');
    await page.locator('#eventDate').fill('2027-01-03');
    await page.locator('#site').selectOption('screen');
    await page.locator('#useSettings').click();
    await page.locator('#work').waitFor({ state: 'visible' });
    await page.locator('#galleryInput').setInputFiles(preview.photo);
    await page.locator('#review').waitFor({ state: 'visible' });
    await page.locator('#message').fill('함께 예배합니다');
    // Simulate a dropped request, then a full page restart with draft recovery.
    await page.route('**/live/api/camera/photo', route => route.abort());
    await page.locator('#send').click();
    await page.getByText('같은 설정으로 재시도해 주세요.', { exact: false }).first().waitFor();
    await page.reload(); await page.locator('#continueResume').click();
    await page.locator('#review').waitFor({ state: 'visible' });
    await page.unroute('**/live/api/camera/photo');
    await page.locator('#send').click();
    await page.getByText('같은 작업으로 계속 촬영하거나 사진을 선택하세요.', { exact: false }).waitFor({ state: 'attached' });
    await preview.archive.cycle(true); await page.locator('#refreshHistory').click();
    assert.equal(preview.published.length, 1); assert.equal(preview.archive.records.size, 2);
    assert.ok([...preview.remote.values()].some(f => f.name === '2027'));
    assert.ok([...preview.remote.values()].some(f => f.name === '20270103 신년감사예배'));
    assert.equal((await page.locator('#history').textContent()).includes('모니터 표시 확인 1곳'), true);
    await page.screenshot({ path: path.join(preview.root, 'camera-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(preview.root, 'camera-mobile.png'), fullPage: true });

    await page.locator('#shoot').click(); await page.locator('#cameraDialog').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#cameraVideo').videoWidth > 0);
    await page.locator('#snap').click(); await page.locator('#review').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#cameraVideo').srcObject === null);
    assert.equal((await page.locator('#selectedPhotos').textContent()).includes('방금 촬영한 날짜'), true);
    await page.locator('#discard').click();

    await page.goto(preview.url + '/photos');
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('.card').count(), 2);
    assert.equal((await page.locator('#grid').textContent()).includes('신년감사예배'), true);
    const clipboard = await page.evaluate(async () => {
      let payload;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: items => {
        payload = items[0].getType('image/png').then(async blob => { const image = await createImageBitmap(blob); const result = [image.width, image.height, blob.type]; image.close(); return result; }); return payload.then(() => {});
      } } });
      [...document.querySelectorAll('button')].find(b => b.textContent === '사진 복사').click();
      return payload;
    });
    assert.deepEqual(clipboard, [1200, 900, 'image/png']);
    assert.deepEqual(errors, []);
    console.log('Chromium passed: purpose-first repetition, original upload, new year/event, failed request and IndexedDB restart recovery, monitor acknowledgement, desktop/mobile layout, simulated PC camera capture/release, library and original-size clipboard.');
  } catch (error) {
    console.error('Original UI failure:', error);
    if (page) console.error('UI state:', await page.evaluate(() => ({ title: document.title, notice: document.querySelector('#notice')?.textContent, setupHidden: document.querySelector('#setup')?.hidden, workHidden: document.querySelector('#work')?.hidden, reviewHidden: document.querySelector('#review')?.hidden, text: document.body.innerText.slice(0, 3000) })));
    throw error;
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
