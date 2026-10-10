// Archive-only bulk upload: more than 30 photos, parallel transfer, automatic retry,
// re-selecting already uploaded photos, and restoring an interrupted batch.
// Only local fixtures; no real monitors, Google, mail or Kakao messages.
const { chromium } = require('../host/node_modules/@playwright/test');
const sharp = require('../host/node_modules/sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview(); let browser, release;
  try {
    const dir = path.join(preview.root, 'bulk'); fs.mkdirSync(dir);
    const files = [];
    for (let i = 0; i < 52; i++) {
      const file = path.join(dir, 'bulk-' + String(i).padStart(2, '0') + '.png'); files.push(file);
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40 + i * 4, g: 120, b: 200 - i * 3 } } }).png().toFile(file);
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    let inflight = 0, peak = 0, posts = 0, failNext = 0;
    const gate = new Promise(resolve => { release = resolve; }); let hold = false;
    await page.route('**/live/api/camera/photo', async route => {
      posts++;
      if (failNext > 0) { failNext--; return route.abort('connectionreset'); }
      inflight++; peak = Math.max(peak, inflight);
      if (hold) await gate;
      await new Promise(resolve => setTimeout(resolve, 30));
      try { await route.continue(); } catch {} finally { inflight--; }
    });
    const openArchive = async () => {
      await page.locator('[data-mode=archive]').click(); await page.locator('#uploader').fill('김예봄');
      await page.waitForFunction(() => foldersReady);
      await page.locator('#chooseFolder').click(); await page.locator('[data-folder-id=event-2026]').click();
      await page.locator('#folderDialog').waitFor({ state: 'hidden' }); await page.locator('#useSettings').click(); await page.locator('#work').waitFor();
    };
    const sendAll = async () => { await page.locator('#send').click(); await page.waitForFunction(() => !busy, null, { timeout: 60000 }); };
    await page.goto(preview.url + '/camera'); await openArchive();

    // 45 photos in one selection: no 30-photo limit, only the first 40 are drawn.
    await page.locator('#galleryInput').setInputFiles(files.slice(0, 45));
    await page.waitForFunction(() => selected.length === 45);
    assert.equal(await page.locator('#selectedPhotos .photoCard').count(), 40);
    await page.locator('#moreReview').click();
    assert.equal(await page.locator('#selectedPhotos .photoCard').count(), 45);
    assert.equal(await page.locator('#reviewTitle').textContent(), '사진 45장');
    await sendAll();
    assert.equal(await page.evaluate(() => selected.length), 0);
    assert.equal(preview.archive.records.size, 45);
    assert.equal(posts, 45); assert.ok(peak >= 2 && peak <= 3, 'photos are sent a few at a time, not one by one: ' + peak);
    assert.match(await page.locator('#notice').textContent(), /45장을 접수했습니다/);

    // Selecting the same photos again (for example after the app was closed) uploads only the new ones.
    posts = 0;
    await page.locator('#galleryInput').setInputFiles(files.slice(40, 48));
    await page.waitForFunction(() => selected.length === 8);
    await sendAll();
    assert.equal(posts, 3, 'five already accepted photos are not sent again');
    assert.equal(preview.archive.records.size, 48);
    assert.match(await page.locator('#notice').textContent(), /이미 올린 사진 5장/);

    // A dropped connection is retried without the user pressing anything.
    posts = 0; failNext = 2;
    await page.locator('#galleryInput').setInputFiles(files.slice(48, 50));
    await page.waitForFunction(() => selected.length === 2);
    await sendAll();
    assert.equal(preview.archive.records.size, 50); assert.ok(posts >= 4);
    assert.equal(await page.evaluate(() => selected.length), 0);

    // Closing the page mid-batch keeps the waiting photos; sending again finishes without duplicates.
    hold = true; posts = 0;
    await page.locator('#galleryInput').setInputFiles(files.slice(50, 52));
    await page.waitForFunction(() => selected.length === 2);
    await page.locator('#send').click(); await page.waitForFunction(() => busy);
    while (posts < 2) await new Promise(resolve => setTimeout(resolve, 20));
    await page.reload(); hold = false; release();
    await page.locator('#continueResume').click(); await page.locator('#work').waitFor();
    assert.equal(await page.evaluate(() => selected.length), 2);
    assert.ok(await page.evaluate(() => selected.every(r => r.submission && r.requestId.startsWith('a-'))));
    await sendAll();
    assert.equal(await page.evaluate(() => selected.length), 0);
    assert.equal(preview.archive.records.size, 52);
    // The draft store holds nothing once everything has been accepted.
    assert.equal(await page.evaluate(async () => (await settle((await openDb()).transaction('files').objectStore('files').getAllKeys())).length), 0);

    // Monitor display keeps its 30-photo limit.
    await page.locator('#changePurpose').click(); await page.locator('[data-mode=live]').click();
    await page.locator('#chooseSite').click(); await page.locator('[data-site-id=screen]').click();
    await page.locator('#siteDialog').waitFor({ state: 'hidden' }); await page.locator('#useSettings').click(); await page.locator('#work').waitFor();
    await page.locator('#galleryInput').setInputFiles(files.slice(0, 31));
    await page.waitForFunction(() => selected.length === 30);
    assert.match(await page.locator('#notice').textContent(), /한 번에 30장까지/);
    assert.deepEqual(errors, []);
    console.log('Chromium bulk archive passed: 45 photos in one selection, paged review, ' + peak + ' parallel transfers, already uploaded photos skipped, dropped connections retried, interrupted batch restored without duplicates, display limit kept at 30.');
  } finally {
    release?.(); if (browser) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
