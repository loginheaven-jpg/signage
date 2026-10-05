// Chromium + real camera API + local Drive/mail fixtures. Never sends real mail
// or launches a real Kakao/share app; only the native share boundary is stubbed.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview({ email: true });
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.clock.install({ time: new Date() });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.shareSupported = true; window.shareCalls = []; window.shareAbort = false;
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => window.shareSupported && !!data.files?.length });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
        if (window.shareAbort) throw new DOMException('Cancelled by user', 'AbortError');
        const details = [];
        for (const file of data.files) { const image = await createImageBitmap(file); details.push([file.type, image.width, image.height]); image.close(); }
        window.shareCalls.push(details);
      } });
    });
    const enter = async mode => {
      await page.locator('#home').click(); await page.locator('#purpose').waitFor();
      await page.locator('[data-mode=' + mode + ']').click();
      await page.locator('#uploader').fill('김예봄');
      if (mode !== 'live') {
        await page.locator('#chooseFolder').click(); await page.locator('[data-folder-id=event-2026]').click();
        await page.locator('#folderDialog').waitFor({ state: 'hidden' });
      }
      if (mode !== 'archive') {
        await page.locator('#chooseSite').click(); await page.locator('#siteDialog').waitFor();
        await page.locator('[data-site-id=screen]').click(); await page.locator('#siteDialog').waitFor({ state: 'hidden' });
      }
      await page.locator('#useSettings').click(); await page.locator('#work').waitFor();
    };
    const send = async (files = preview.photo) => {
      await page.locator('#galleryInput').setInputFiles(files);
      await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector('#home').disabled && document.querySelector('#progress').textContent.includes('서버 접수 완료'));
      await page.locator('#refreshHistory').click();
    };

    await page.goto(preview.url + '/camera');
    await enter('archive');
    assert.equal(await page.locator('#communication').isVisible(), false);
    await send(); assert.equal(preview.mail.jobs.size, 0);
    assert.equal(await page.locator('#shareResult').isVisible(), false);

    await enter('live');
    assert.equal(await page.locator('#communication').isVisible(), true, 'email available before selecting a photo');
    await page.locator('#email').fill('guest@gmial.com');
    await page.locator('#emailSuggestion button').click();
    assert.equal(await page.locator('#email').inputValue(), 'guest@gmail.com');
    await send();
    assert.equal(preview.mail.jobs.size, 1); assert.equal(preview.sent.length, 0);
    assert.equal(await page.locator('#emailKeep').isVisible(), true);
    assert.equal(await page.locator('#email').inputValue(), 'guest@gmail.com');
    await page.locator('#sharePhotos').click();
    await page.waitForFunction(() => window.shareCalls.length === 1 && !document.querySelector('#sharePhotos').disabled);
    assert.deepEqual(await page.evaluate(() => window.shareCalls), [[['image/jpeg', 1200, 900]]]);
    await page.evaluate(() => { window.shareAbort = true; });
    const previousNotice = await page.locator('#notice').textContent();
    await page.locator('#sharePhotos').click();
    await page.waitForFunction(() => !document.querySelector('#sharePhotos').disabled);
    assert.equal(await page.locator('#notice').textContent(), previousNotice, 'closing the share sheet is not an error or a claimed delivery');
    await page.evaluate(() => { window.shareAbort = false; window.shareSupported = false; renderShare(); });
    assert.equal(await page.locator('#sharePhotos').isVisible(), false);
    assert.equal(await page.locator('#shareDownloads a').count(), 1);
    assert.ok((await page.locator('#shareHint').textContent()).includes('내려받은 뒤'));
    await page.evaluate(() => { window.shareSupported = true; renderShare(); });

    const published = preview.published.length;
    await page.locator('[data-mail-cancel]').click();
    await page.waitForFunction(() => document.querySelector('#history').textContent.includes('이메일: 취소됨'));
    assert.equal(preview.mail.jobs.size, 0); assert.equal(preview.published.length, published);
    assert.equal(await page.locator('#email').inputValue(), '');
    assert.equal(await page.locator('#shareResult').isVisible(), true, 'mail-only cancel retains share photos');

    await enter('both'); await page.locator('#email').fill('next@example.com'); await send();
    await preview.archive.cycle(true);
    assert.equal(preview.archive.records.size, 2, 'archive-only and both retain originals');
    assert.equal(preview.mail.jobs.size, 1);
    await page.reload(); await page.locator('#continueResume').click();
    await page.locator('#shareResult').waitFor();
    assert.equal(await page.locator('#email').inputValue(), 'next@example.com');
    await page.locator('#sharePhotos').click();
    await page.waitForFunction(() => window.shareCalls.length === 1 && !document.querySelector('#sharePhotos').disabled);
    assert.deepEqual(await page.evaluate(() => window.shareCalls), [[['image/jpeg', 1200, 900]]], 'File objects survive IndexedDB restart');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('camera.email')));
    await page.locator('#home').click(); await page.locator('#continueResume').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('camera.email')).at), saved.at, 'navigation does not extend recipient retention');
    await page.clock.fastForward(10 * 60000 + 31000);
    assert.equal(await page.locator('#email').inputValue(), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('camera.email')), 'null');
    // The mock mailer advances only explicitly, not with the browser clock.
    preview.clock.now += 63000; await preview.mail.cycle();
    assert.equal(preview.sent.length, 1); await page.locator('#refreshHistory').click();
    await page.waitForFunction(() => document.querySelector('#history').textContent.includes('이메일: 발송 완료'));
    assert.equal(await page.locator('[data-mail-cancel]').count(), 0);
    await page.clock.resume();

    await enter('live'); await page.locator('#email').fill('batch@example.com');
    const beforeBatch = preview.published.length, bytes = fs.readFileSync(preview.photo);
    await send(['first.png', 'second.png'].map(name => ({ name, mimeType: 'image/png', buffer: bytes })));
    await page.locator('#cancelBatchMail').click();
    await page.waitForFunction(() => document.querySelector('#cancelBatchMail').hidden);
    assert.equal(preview.mail.jobs.size, 0); assert.equal(preview.published.length, beforeBatch + 2);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#cancelBatch').click(); await page.locator('#shareResult').waitFor({ state: 'hidden' });
    assert.equal(preview.published.length, beforeBatch);
    assert.equal(preview.archive.records.size, 2);

    preview.mail.configured = false;
    await enter('live');
    assert.equal(await page.locator('#email').isDisabled(), true);
    assert.ok((await page.locator('#emailAvailability').textContent()).includes('설정되어 있지'));
    await enter('archive');
    assert.equal(await page.locator('#communication').isVisible(), false);
    assert.equal(await page.locator('#shareResult').isVisible(), false);
    // Expiring requests is observable and leaves the app available for retry.
    await page.route('**/live/api/camera/config', () => {});
    const timeout = await page.evaluate(async () => { try { await api('config', { timeoutMs: 50 }); return ''; } catch (error) { return error.message; } });
    assert.ok(timeout.includes('응답 시간이 초과'));
    await page.unroute('**/live/api/camera/config');
    assert.deepEqual(errors, []);
    preview.mail.configured = true;
    const legacy = await browser.newPage();
    await legacy.addInitScript(() => {
      if (!localStorage.getItem('seeded')) {
        localStorage.setItem('live.uploaderName', '이전촬영자'); localStorage.setItem('live.siteId', 'screen');
        localStorage.setItem('live.token', 'legacy-preview-token'); localStorage.setItem('live.draftMail', 'legacy@example.com');
        localStorage.setItem('live.mailAt', String(Date.now())); localStorage.setItem('live.mailKept', '1'); localStorage.setItem('seeded', '1');
      }
    });
    await legacy.goto(preview.url + '/camera'); await legacy.locator('[data-mode=live]').click();
    assert.equal(await legacy.locator('#uploader').inputValue(), '이전촬영자');
    assert.equal(await legacy.locator('#site').inputValue(), 'screen');
    await legacy.waitForFunction(() => sitesReady); await legacy.locator('#useSettings').click();
    assert.equal(await legacy.locator('#email').inputValue(), 'legacy@example.com');
    assert.equal(await legacy.evaluate(() => localStorage.getItem('live.draftMail')), null);
    await legacy.locator('#clearEmail').click(); await legacy.reload(); await legacy.locator('#continueResume').click();
    assert.equal(await legacy.locator('#email').inputValue(), '', 'cleared legacy addresses never reappear');
    await legacy.locator('#galleryInput').setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
    await legacy.waitForFunction(() => document.querySelector('#notice').textContent.includes('비어 있습니다'));
    assert.equal(await legacy.locator('#review').isVisible(), false);
    await legacy.close();
    console.log('Chromium communications passed: archive exclusion; live/both email before capture, typo correction, 10-minute retention/expiry, owner mail-only and batch cancellation, delayed fake SMTP, native photo sharing and cancel/fallback, share/draft reload, unconfigured mail notice, request timeout.');
  } catch (error) {
    if (page) console.error(await page.locator('body').innerText());
    throw error;
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
