// Background Fetch for bulk archive: the browser keeps uploading after the camera page is closed.
// Needs a visible browser window: headless Chromium never grants the background-fetch permission,
// so this is not part of `npm run test:camera-ui`. Run with `npm run test:camera-background`.
// Only local fixtures; no real monitors, Google, mail or Kakao messages.
const { chromium } = require('../host/node_modules/@playwright/test');
const sharp = require('../host/node_modules/sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPreview } = require('./camera-preview.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const preview = await startPreview(); let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-background-'));
  try {
    const dir = path.join(preview.root, 'bulk'); fs.mkdirSync(dir);
    const files = [];
    for (let i = 0; i < 26; i++) {
      const file = path.join(dir, 'bg-' + String(i).padStart(2, '0') + '.png'); files.push(file);
      await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 30 + i * 8, g: 90, b: 220 - i * 6 } } }).png({ compressionLevel: 0 }).toFile(file);
    }
    const broken = path.join(dir, 'not-a-photo.png'); fs.writeFileSync(broken, 'this is not a photo');
    context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 390, height: 844 } });
    let page = context.pages()[0] || await context.newPage();
    const errors = []; const watch = p => { p.on('pageerror', error => errors.push(error.message)); p.on('dialog', dialog => dialog.accept()); };
    watch(page);
    await page.goto(preview.url + '/camera');
    const permission = await page.evaluate(async () => {
      const worker = await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 5000))]);
      return worker?.backgroundFetch ? (await navigator.permissions.query({ name: 'background-fetch' })).state : 'unsupported';
    });
    if (permission !== 'granted') { console.log('Background Fetch is not available in this browser (' + permission + '); skipped.'); return; }
    await page.locator('[data-mode=archive]').click(); await page.locator('#uploader').fill('김예봄');
    await page.waitForFunction(() => foldersReady);
    await page.locator('#chooseFolder').click(); await page.locator('[data-folder-id=event-2026]').click();
    await page.locator('#folderDialog').waitFor({ state: 'hidden' }); await page.locator('#useSettings').click(); await page.locator('#work').waitFor();

    // 1. A large batch is handed to the browser, and closing the camera page does not stop it.
    await page.locator('#galleryInput').setInputFiles(files.slice(0, 20));
    await page.waitForFunction(() => selected.length === 20);
    await page.locator('#send').click();
    await page.waitForFunction(() => backgroundActive, null, { timeout: 15000 });
    assert.match(await page.locator('#progress').textContent(), /접수 완료/);
    const atClose = preview.archive.records.size;
    const other = await context.newPage();   // the browser itself stays open, as it does on a phone
    await page.close();
    for (let i = 0; i < 300 && preview.archive.records.size < 20; i++) await sleep(200);
    assert.equal(preview.archive.records.size, 20, 'all photos arrive although the page was closed (' + atClose + ' had arrived when it closed)');

    // 2. Reopening the app finds nothing left to send and creates no duplicates.
    page = await context.newPage(); watch(page);
    await page.goto(preview.url + '/camera');
    await page.locator('#continueResume').click(); await page.locator('#work').waitFor();
    if (await page.evaluate(() => selected.length)) {
      if (!await page.evaluate(() => busy)) await page.locator('#send').click();
      await page.waitForFunction(() => !busy && !selected.length, null, { timeout: 60000 });
    }
    assert.equal(preview.archive.records.size, 20);
    assert.equal(await page.evaluate(() => storage.get('bgFetch')), null);

    // 3. One unusable file does not stop the others; it is reported after the rest are accepted.
    await page.locator('#galleryInput').setInputFiles([...files.slice(20, 26), broken, ...files.slice(0, 5)]);
    await page.waitForFunction(() => selected.length === 12);
    await page.locator('#send').click();
    await page.waitForFunction(() => !busy, null, { timeout: 90000 });
    assert.equal(preview.archive.records.size, 26, 'six new photos saved, five already uploaded photos skipped');
    assert.deepEqual(await page.evaluate(() => selected.map(r => r.file.name)), ['not-a-photo.png']);
    assert.match(await page.evaluate(() => selected[0].error), /사진만 올릴 수 있습니다/);
    assert.deepEqual(errors, []);
    console.log('Chromium background transfer passed: 20 photos handed to the browser, ' + atClose + ' had arrived when the camera page was closed and all 20 arrived afterwards, reopening created no duplicates, an unusable file did not stop the rest.');
  } finally {
    if (context) await context.close().catch(() => {}); await preview.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
