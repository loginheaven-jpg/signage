// Real Chromium, local Drive fixture and the production web-player rendering.
// No real monitors, Google requests or messages are used.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview(); let browser, page;
  try {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const list = preview.drive.files.list;
    preview.drive.files.list = async (...args) => { started ||= Date.now(); await gate; return list(...args); };
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let folderCalls = 0; page.on('request', request => { if (request.url().includes('/camera/folders?')) folderCalls++; });
    await page.goto(preview.url + '/camera');
    await page.waitForFunction(() => document.querySelector('#purpose').hidden === false);
    // Purpose selection is not required to start loading Drive.
    while (!started) await new Promise(resolve => setTimeout(resolve, 10));
    await page.locator('[data-mode=archive]').click();
    assert.equal(await page.locator('#chooseFolder').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('#folderState').textContent.includes('초 (최대'));
    // A 16-second first read used to be aborted at 15 seconds, then retried.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 16000 - (Date.now() - started)))); release();
    await page.waitForFunction(() => !document.querySelector('#chooseFolder').disabled);
    assert.equal(folderCalls, 1, 'setup joins the background request');
    await page.locator('#chooseFolder').click();
    assert.equal(await page.locator('#folderList button').count(), 5);
    await page.goBack();
    await page.route('**/live/api/camera/folders?**', route => route.fulfill({ status: 504, json: { error: '폴더 조회 시간이 초과되었습니다.' } }));
    await page.locator('#reloadFolders').click();
    await page.waitForFunction(() => document.querySelector('#folderState').textContent.includes('시간이 초과'));
    assert.equal(await page.locator('#reloadFolders').isDisabled(), false);
    assert.equal(await page.locator('#chooseFolder').isDisabled(), true);
    await page.unroute('**/live/api/camera/folders?**');
    await page.locator('#reloadFolders').click();
    await page.waitForFunction(() => !document.querySelector('#chooseFolder').disabled);

    // A transport/body reader that ignores AbortSignal used to leave the UI
    // checking forever. Accelerate only the folder deadline, not app logic.
    const stalled = await browser.newPage({ viewport: { width: 390, height: 844 } });
    stalled.on('pageerror', error => errors.push(error.message));
    await stalled.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window), nativeTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 25000 ? 250 : ms, ...args);
      window.fetch = (url, options) => {
        if (String(url).includes('/camera/folders?') && !window.folderRecovered) {
          window.stalledFolderCalls = (window.stalledFolderCalls || 0) + 1;
          return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { window.releaseStalledFolder = resolve; }) });
        }
        return nativeFetch(url, options);
      };
    });
    await stalled.goto(preview.url + '/camera');
    await stalled.locator('[data-mode=both]').click();
    await stalled.locator('#uploader').fill('폴더점검');
    await stalled.locator('#chooseSite').click();
    await stalled.locator('[data-site-id=screen]').click();
    await stalled.locator('#useSettings').click();
    await stalled.waitForFunction(() => document.querySelector('#folderState').textContent.includes('시간이 초과')).catch(async error => {
      console.error(errors, await stalled.evaluate(() => ({ page: currentPage, folderState: el('folderState').textContent, notice: el('notice').textContent, folderSequence, foldersReady, settings, formValid: el('setupForm').checkValidity(), sitesReady, calls: window.stalledFolderCalls, requests: [...folderRequests].map(([key, value]) => ({ key, pending: value.pending })) })));
      throw error;
    });
    assert.equal(await stalled.locator('#reloadFolders').isDisabled(), false);
    assert.equal(await stalled.locator('#shoot').isEnabled(), true, 'folder failure cannot block camera work');
    assert.equal(await stalled.evaluate(() => folderRequests.size), 0, 'stalled prefetch cannot pin future requests');
    await stalled.evaluate(() => { window.folderRecovered = true; });
    await stalled.locator('#reloadFolders').click();
    await stalled.waitForFunction(() => !document.querySelector('#chooseFolder').disabled);
    await stalled.evaluate(() => window.releaseStalledFolder({ years: [], events: [], yearId: '', exists: false, ambiguous: false }));
    await stalled.waitForTimeout(50);
    assert.equal(await stalled.evaluate(() => events.length), 5, 'late timed-out body cannot replace recovered list');
    assert.equal(await stalled.locator('#reloadFolders').isDisabled(), false);
    await stalled.close();

    const denied = await browser.newPage({ viewport: { width: 390, height: 844 } });
    denied.on('pageerror', error => errors.push(error.message));
    await denied.route('**/live/api/camera/folders?**', route => route.fulfill({ status: 403, json: { error: 'Google 계정 연결과 폴더의 편집 권한을 확인해 주세요. [FOLDERS_ROOT_403]' } }));
    await denied.goto(preview.url + '/camera');
    await denied.locator('[data-mode=archive]').click();
    await denied.waitForFunction(() => document.querySelector('#folderState').textContent.includes('FOLDERS_ROOT_403'));
    assert.equal(await denied.locator('#chooseFolder').isDisabled(), true);
    assert.equal(await denied.locator('#reloadFolders').isDisabled(), false);
    assert.equal(await denied.locator('#useSettings').isDisabled(), true);
    await denied.unroute('**/live/api/camera/folders?**');
    await denied.locator('#reloadFolders').click();
    await denied.waitForFunction(() => !document.querySelector('#chooseFolder').disabled);
    assert.equal(await denied.evaluate(() => events.length), 5);
    await denied.close();

    // Exercise real hero/grid removal and cancellation while image decoding is pending.
    await page.goto(preview.url + '/player.html');
    const image = fs.readFileSync(preview.photo);
    await page.route('**/test-photo*', route => route.fulfill({ contentType: 'image/png', body: image }));
    const receive = id => page.evaluate(id => handleMessage({ type: 'live_photo', photo: { id, url: '/test-photo.png?id=' + id, ts: Date.now() }, settings: { heroMs: 60000, returnMs: 60000 } }), id);
    const remove = id => page.evaluate(id => handleMessage({ type: 'live_update', removedId: id }), id);
    await receive('first');
    await page.waitForFunction(() => liveState === 'hero' && document.querySelector('#live-hero').dataset.photoId === 'first');
    await receive('second'); await page.waitForFunction(() => liveSlots.length === 2);
    await page.evaluate(() => heroDone());
    await page.waitForFunction(() => document.querySelector('#live-hero').dataset.photoId === 'second');
    await remove('second');
    await page.waitForFunction(() => liveState === 'grid' && liveSlots.length === 1 && !document.querySelector('#live-hero').dataset.photoId);
    assert.equal(await page.locator('#live-grid img').count(), 1);
    await remove('first');
    await page.waitForFunction(() => !document.querySelector('#live-layer').classList.contains('on'));
    assert.equal(await page.locator('#live-layer img').count(), 0);
    let releaseImage;
    const imageGate = new Promise(resolve => { releaseImage = resolve; });
    await page.route('**/held-photo.png', async route => { await imageGate; await route.fulfill({ contentType: 'image/png', body: image }); });
    await page.evaluate(() => handleMessage({ type: 'live_photo', photo: { id: 'pending', url: '/held-photo.png' } }));
    await remove('pending'); releaseImage();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => liveSlots.length), 0);
    assert.equal(await page.evaluate(() => liveState), 'off');
    assert.deepEqual(errors, []);
    console.log('Chromium reliability passed: startup prefetch, coalesced 16-second Drive read, first folder failure with no recent selection leaves checking and retries successfully, abort-ignoring stalled body bounded, late result discarded, real web-player hero/grid cancellation and cancelled pending image never displayed.');
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
