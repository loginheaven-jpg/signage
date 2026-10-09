// Camera page: pick a video, choose sound, send it, and watch it reach the monitor and the archive.
// Only local fixtures; no real monitors, Google, mail or Kakao messages.
const { chromium } = require('../host/node_modules/@playwright/test');
const ffmpeg = require('../host/node_modules/@ffmpeg-installer/ffmpeg').path;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview(); let browser;
  try {
    const clip = path.join(preview.root, 'clip.webm');
    // VP8/WebM so the bundled test browser can read the length; phones send MP4/MOV through the same path.
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libvorbis', '-shortest', clip]);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(preview.url + '/camera');
    await page.locator('[data-mode=both]').click(); await page.locator('#uploader').fill('김예봄');
    await page.locator('#chooseSite').click(); await page.locator('[data-site-id=screen]').click();
    await page.locator('#siteDialog').waitFor({ state: 'hidden' }); await page.locator('#useSettings').click();
    await page.locator('#work').waitFor();
    assert.equal(await page.locator('#shootVideo').isVisible(), true);
    assert.equal(await page.locator('#muteLabel').isVisible(), false, 'the sound choice appears only with a video');

    await page.locator('#galleryInput').setInputFiles([preview.photo, clip]);
    await page.locator('#review').waitFor();
    assert.match(await page.locator('#reviewTitle').textContent(), /사진 1장 · 영상 1개/);
    assert.match(await page.locator('#selectedPhotos').textContent(), /영상 2초/);
    assert.equal(await page.locator('#muteVideo').isChecked(), true, 'silent is the default');
    await page.locator('#muteVideo').uncheck();
    await page.locator('#message').fill('환영합니다');
    await page.locator('#send').click();
    await page.waitForFunction(() => !busy && document.querySelector('#review').hidden, null, { timeout: 60000 });

    for (let i = 0; i < 300 && preview.published.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    const video = preview.published.find(p => !Buffer.isBuffer(p.bytes)), photo = preview.published.find(p => Buffer.isBuffer(p.bytes));
    assert.ok(photo, 'the photo in the same batch still goes through the photo path');
    assert.ok(video, 'the video was converted and published');
    assert.equal(video.bytes.muted, false); assert.ok(Math.abs(video.bytes.durationMs - 2000) < 300);
    assert.equal(video.photo.message, '환영합니다');
    const record = [...preview.archive.records.values()].find(r => r.mimeType === 'video/webm');
    assert.ok(record, 'the original video is kept for the church folder');
    assert.equal(record.status, 'awaiting_target', 'the folder can be chosen afterwards, like photos');
    assert.equal(fs.statSync(preview.archive.localPath(record)).size, fs.statSync(clip).size);
    await page.locator('#refreshHistory').click();
    await page.waitForFunction(() => /모니터 표시 확인/.test(document.querySelector('#history').textContent));
    assert.equal(await page.evaluate(() => selected.length), 0);
    assert.deepEqual(errors, []);
    console.log('camera video smoke: ok');
  } finally { await browser?.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
