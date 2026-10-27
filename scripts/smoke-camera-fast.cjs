const cameraUI=require('./helpers/camera-ui.cjs');
// Large originals, blocked folder lookup and interrupted background transfers.
// Only local fixtures; no real monitors, Google, mail or Kakao messages.
const { chromium } = require('../host/node_modules/@playwright/test');
const sharp = require('../host/node_modules/sharp');
const assert = require('node:assert/strict');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview(); let browser, page, releaseFolders, releaseOriginals;
  try {
    const image = await sharp({ create: { width: 2500, height: 2000, channels: 3, background: '#6c8071' } }).png({ compressionLevel: 0 }).toBuffer();
    const folders = new Promise(resolve => { releaseFolders = resolve; });
    const originalsGate = new Promise(resolve => { releaseOriginals = resolve; });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/live/api/camera/folders?**', async route => { await folders; await route.continue().catch(() => {}); });
    let originalAttempts = 0, previewSize = 0;
    await page.route('**/live/api/camera/uploads/*/original', async route => { originalAttempts++; await originalsGate; await route.continue().catch(() => {}); });
    page.on('request', request => { if (request.url().endsWith('/camera/preview')) previewSize = request.postDataBuffer()?.length || 0; });
    await page.goto(preview.url + '/camera');
    await cameraUI.click(page,'[data-mode=both]'); await cameraUI.fill(page,'#uploader','김예봄');
    await cameraUI.click(page,'#chooseSite'); await cameraUI.click(page,'[data-site-id=screen]');
    await page.locator('#siteDialog').waitFor({ state: 'hidden' }); await cameraUI.click(page,'#useSettings');
    await page.locator('#work').waitFor(); assert.equal(await page.locator('#chooseFolder').isDisabled(), true);
    const send = async name => {
      await page.locator('#galleryInput').setInputFiles({ name, mimeType: 'image/png', buffer: image });
      const start = Date.now(); await cameraUI.click(page,'#send');
      await page.waitForFunction(() => !busy && document.querySelector('#review').hidden);
      return Date.now() - start;
    };
    const firstMs = await send('first-original.png');
    assert.equal(preview.published.length, 1); assert.equal(preview.archive.records.size, 0);
    assert.ok(previewSize < image.length / 10, 'display payload is much smaller than the unchanged original');
    assert.equal(await page.locator('#shoot').isDisabled(), false);
    await page.waitForFunction(() => originalRunning);
    await send('second-original.png');
    assert.equal(preview.published.length, 2); assert.equal(preview.archive.records.size, 0);
    assert.ok(originalAttempts >= 1); assert.equal(await page.evaluate(() => originals.length), 2);
    // Reload during a held original. Resume without re-publishing either photo.
    await page.reload(); await cameraUI.click(page,'#continueResume'); await page.locator('#work').waitFor();
    assert.equal(preview.published.length, 2); assert.equal(await page.evaluate(() => originals.length), 2);
    releaseOriginals();
    await page.waitForFunction(() => originals.length === 0);
    await cameraUI.click(page,'#refreshHistory');
    assert.equal(preview.archive.records.size, 2);
    await preview.archive.cycle(true);
    assert.ok([...preview.archive.records.values()].every(r => r.status === 'saved' && r.target.eventName === '미분류' && r.verifiedAt));
    assert.equal(await page.evaluate(() => storage.get('lastTarget')), null, 'automatic archive is not a personal selection');
    releaseFolders(); await page.waitForFunction(() => foldersReady);
    await cameraUI.click(page,'#chooseFolder'); await cameraUI.click(page,'[data-folder-id=event-2026]');
    await page.locator('#folderDialog').waitFor({ state: 'hidden' }); await cameraUI.click(page,'#saveLocation');
    await page.waitForFunction(() => !assigningLocation);
    await preview.archive.cycle(true); await cameraUI.click(page,'#refreshHistory');
    if ([...preview.archive.records.values()].some(r => r.status === 'pending')) await preview.archive.cycle(true);
    assert.ok([...preview.archive.records.values()].every(r => r.status === 'saved'));
    for (const r of preview.archive.records.values()) assert.deepEqual(preview.remote.get(r.driveId).bytes, image);
    await cameraUI.click(page,'#chooseFolder'); await cameraUI.click(page,'[data-folder-id=event-newest]');
    await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => settings.target.eventId), 'event-2026');
    assert.equal(await page.evaluate(() => storage.get('lastTarget').eventId), 'event-2026', 'unconfirmed selection does not change the next-photo destination');
    const firstId = preview.published[0].photo.id;
    await cameraUI.click(page,'[data-withdraw="' + firstId + '"]');
    await page.waitForFunction(() => document.querySelector('#history').textContent.includes('모니터 게시 취소'));
    assert.equal(preview.published.length, 1); assert.ok([...preview.archive.records.values()].every(r => r.status === 'saved'));
    await cameraUI.click(page,'#withdrawBatch'); await page.waitForFunction(() => document.querySelector('#withdrawBatch').hidden);
    assert.equal(preview.published.length, 0); assert.ok([...preview.archive.records.values()].every(r => r.status === 'saved'));
    assert.deepEqual(errors, []);
    console.log('Chromium fast flow passed: blocked folders do not block capture; reduced display payload; another publication interrupts original transfer; restart resumes originals without republishing; automatic unclassified fallback saves both exact originals despite blocked folder UI; later personal selection never retargets them; publication-only cancellation preserves archive. Local first display request completed in ' + firstMs + 'ms (' + previewSize + ' display bytes vs ' + image.length + ' original bytes).');
  } finally {
    releaseFolders?.(); releaseOriginals?.(); if (browser) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
