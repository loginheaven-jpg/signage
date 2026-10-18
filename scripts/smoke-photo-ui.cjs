const cameraUI=require('./helpers/camera-ui.cjs');
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
    const chooseFolder = async id => {
      await cameraUI.click(page,'#chooseFolder');
      await cameraUI.click(page,'[data-folder-id="' + id + '"]');
      await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    };
    const chooseSite = async id => {
      await cameraUI.click(page,'#chooseSite');
      await page.locator('#siteDialog').waitFor({ state: 'visible' });
      await page.locator('#siteList button').first().waitFor();
      assert.deepEqual(await page.locator('#siteList button').evaluateAll(rows => rows.map(r => r.dataset.siteId)), ['screen', 'offline']);
      assert.equal(await page.locator('#siteList .offline').evaluate(dot => getComputedStyle(dot).backgroundColor), 'rgb(133, 141, 137)');
      assert.equal(await page.locator('#siteList .online').evaluate(dot => getComputedStyle(dot).backgroundColor), 'rgb(38, 133, 76)');
      await cameraUI.click(page,'[data-site-id="' + id + '"]');
      await page.locator('#siteDialog').waitFor({ state: 'hidden' });
    };
    await page.goto(preview.url + '/camera');
    assert.deepEqual(await page.locator('[data-mode]').evaluateAll(rows => rows.map(r => r.dataset.mode)), ['both', 'live', 'archive']);
    assert.equal(await page.locator('[data-mode=both] .badge').textContent(), '기본');
    await cameraUI.click(page,'[data-mode=archive]');
    await cameraUI.fill(page,'#uploader','김예봄');
    await cameraUI.click(page,'#chooseFolder');
    assert.equal(await page.locator('#folderDialog button').nth(1).textContent(), '＋ 새 폴더');
    assert.deepEqual(await page.locator('#folderList button').evaluateAll(rows => rows.map(r => r.dataset.folderId)), ['event-newest', 'event-2026', 'event-old', 'event-name-a', 'event-name-b']);
    await cameraUI.fill(page,'#eventSearch','목자');
    assert.equal(await page.locator('#folderList button').count(), 1);
    await cameraUI.click(page,'[data-folder-id=event-2026]');
    await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    await cameraUI.click(page,'#chooseFolder');
    assert.equal(await page.locator('#folderList button').first().getAttribute('data-folder-id'), 'event-2026');
    await page.goBack(); await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#setup').isVisible(), true);
    await cameraUI.click(page,'#useSettings');
    await page.locator('#galleryInput').setInputFiles(preview.photo);
    await page.locator('#review').waitFor({ state: 'visible' });
    await cameraUI.click(page,'#home'); await page.locator('#captureHome').waitFor();
    assert.equal(await page.locator('#draftCount').textContent(), '대기 사진 1장 · 사진과 작업 설정을 유지하고 있습니다.');
    await cameraUI.click(page,'#continueResume'); await page.locator('#review').waitFor();
    // Hold the request to verify mobile/browser back cannot abandon an upload.
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/live/api/camera/photo', async route => { await gate; await route.continue(); });
    await cameraUI.click(page,'#send');
    await page.waitForFunction(() => document.querySelector('#home').disabled);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('접수가 진행 중'));
    assert.equal(await page.locator('#work').isVisible(), true);
    release();
    await page.getByText('같은 작업으로 계속 촬영하거나 사진을 선택하세요.', { exact: false }).waitFor({ state: 'attached' });
    await page.unroute('**/live/api/camera/photo');
    assert.equal(preview.published.length, 0);
    await preview.archive.cycle(true); await cameraUI.click(page,'#refreshHistory');
    await page.getByText('Drive 보관 완료', { exact: true }).waitFor();
    assert.equal(preview.archive.records.size, 1);

    await cameraUI.click(page,'#changePurpose');
    await cameraUI.click(page,'[data-mode=both]');
    await chooseSite('screen'); await cameraUI.click(page,'#useSettings'); await page.locator('#work').waitFor();
    assert.equal(await page.locator('#event').inputValue(), 'event-2026');
    await cameraUI.fill(page,'#year','2027'); await page.locator('#year').press('Tab');
    await cameraUI.click(page,'#chooseFolder'); await cameraUI.click(page,'#createFolder');
    await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    await cameraUI.fill(page,'#eventName','신년감사예배');
    await cameraUI.fill(page,'#eventDate','2027-01-03');
    await cameraUI.click(page,'#saveLocation');
    await cameraUI.click(page,'#home'); await cameraUI.click(page,'[data-mode=both]');
    await chooseSite('screen'); await cameraUI.click(page,'#useSettings'); await page.locator('#work').waitFor();
    await page.waitForFunction(() => document.querySelector('#event').value === '__new__');
    assert.equal(await page.locator('#eventName').inputValue(), '신년감사예배');
    assert.equal(await page.locator('#eventDate').inputValue(), '2027-01-03');
    assert.equal([...preview.remote.values()].some(f => f.name === '2027'), false);
    await page.locator('#galleryInput').setInputFiles(preview.photo);
    await page.locator('#review').waitFor({ state: 'visible' });
    await cameraUI.fill(page,'#message','함께 예배합니다');
    // Simulate a dropped request, then a full page restart with draft recovery.
    await page.route('**/live/api/camera/preview', route => route.abort());
    await cameraUI.click(page,'#send');
    await page.getByText('같은 설정으로 재시도해 주세요.', { exact: false }).first().waitFor();
    await page.reload(); await cameraUI.click(page,'#continueResume');
    await page.locator('#review').waitFor({ state: 'visible' });
    await page.unroute('**/live/api/camera/preview');
    await cameraUI.click(page,'#send');
    await page.getByText('같은 작업으로 계속 촬영하거나 사진을 선택하세요.', { exact: false }).waitFor({ state: 'attached' });
    await page.waitForFunction(() => originals.length === 0);
    await preview.archive.cycle(true); await cameraUI.click(page,'#refreshHistory');
    assert.equal(preview.published.length, 1); assert.equal(preview.archive.records.size, 2);
    assert.ok([...preview.remote.values()].some(f => f.name === '2027'));
    assert.ok([...preview.remote.values()].some(f => f.name === '20270103 신년감사예배'));
    assert.equal((await page.locator('#history').textContent()).includes('모니터 표시 확인 1곳'), true);
    assert.equal(await page.locator('#workSummary .online').count(), 1);
    await page.screenshot({ path: path.join(preview.root, 'camera-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(preview.root, 'camera-mobile.png'), fullPage: true });
    await cameraUI.click(page,'#changeSettings');
    await cameraUI.click(page,'#useSettings'); await page.locator('#work').waitFor();
    await page.waitForFunction(() => document.querySelector('#event').value && document.querySelector('#event').value !== '__new__');
    const createdId = await page.locator('#event').inputValue();
    await cameraUI.fill(page,'#year','2026'); await page.locator('#year').press('Tab');
    await page.waitForFunction(() => document.querySelector('#event').value === 'event-2026');
    await cameraUI.fill(page,'#year','2027'); await page.locator('#year').press('Tab');
    await page.waitForFunction(id => document.querySelector('#event').value === id, createdId);
    await cameraUI.click(page,'#chooseFolder');
    assert.equal(await page.evaluate(() => Math.abs(document.querySelector('#folderDialog').getBoundingClientRect().bottom - innerHeight) < 2), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goBack(); await page.locator('#folderDialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    assert.equal(await page.locator('#home').evaluate(b => b.getBoundingClientRect().top >= 0 && b.getBoundingClientRect().bottom <= innerHeight), true);

    await cameraUI.click(page,'#shoot'); await page.locator('#cameraDialog').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#cameraVideo').videoWidth > 0);
    await cameraUI.click(page,'#snap'); await page.locator('#review').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#beautyDialog').isVisible(),false,'capturing goes directly to review; editing is optional');
    await page.waitForFunction(() => document.querySelector('#cameraVideo').srcObject === null);
    assert.equal((await page.locator('#selectedPhotos').textContent()).includes('방금 촬영한 날짜'), true);
    await cameraUI.click(page,'#discard');

    // Home and a live-only task must preserve the last archive target.
    await cameraUI.click(page,'#home'); await cameraUI.click(page,'[data-mode=live]');
    await chooseSite('offline'); await cameraUI.click(page,'#useSettings');
    assert.equal(await page.locator('#workSummary .offline').count(), 1);
    await page.goBack(); await page.locator('#setup').waitFor();
    await page.route('**/live/api/camera/config', route => route.fulfill({ status: 503, json: { error: '연결 상태 조회 실패' } }));
    await cameraUI.click(page,'#chooseSite'); await page.locator('#siteDialog').waitFor();
    assert.equal(await page.locator('#siteList button').count(), 0);
    await cameraUI.click(page,'#closeSites'); await page.locator('#siteDialog').waitFor({ state: 'hidden' });
    await cameraUI.click(page,'#useSettings');
    assert.equal(await page.locator('#setup').isVisible(), true);
    await page.unroute('**/live/api/camera/config'); await chooseSite('offline');
    await page.goBack(); await page.locator('#purpose').waitFor();
    await cameraUI.click(page,'[data-mode=archive]');
    await page.waitForFunction(id => document.querySelector('#event').value === id, createdId);
    // A deleted recent folder must require an explicit replacement.
    preview.remote.get(createdId).trashed = true;
    await cameraUI.click(page,'#reloadFolders');
    await page.waitForFunction(() => document.querySelector('#folderState').textContent.includes('다시 선택'));
    assert.equal(await page.locator('#event').inputValue(), '');
    preview.remote.get(createdId).trashed = false;
    await cameraUI.click(page,'#reloadFolders'); await chooseFolder(createdId);
    // Failed listing never unlocks new-folder creation.
    await page.route('**/live/api/camera/folders?**', route => route.fulfill({ status: 503, json: { error: 'Google 연결 확인 필요' } }));
    await cameraUI.click(page,'#reloadFolders');
    await page.waitForFunction(() => document.querySelector('#folderState').textContent.includes('Google 연결 확인 필요'));
    assert.equal(await page.locator('#chooseFolder').isDisabled(), true);
    assert.equal(await page.locator('#useSettings').isDisabled(), true);
    await page.unroute('**/live/api/camera/folders?**');
    await cameraUI.click(page,'#reloadFolders'); await chooseFolder(createdId); await cameraUI.click(page,'#useSettings');
    await page.reload(); await cameraUI.click(page,'[data-mode=archive]');
    await page.waitForFunction(id => document.querySelector('#event').value === id, createdId);

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
    console.log('Chromium passed: menu order, folder search/sort and per-year memory, sheets and browser back, home/draft recovery, busy navigation guard, green/gray monitor states, deleted folder/list failure, purpose-first repetition, original upload, new year/event, request retry/reload, mobile layout, simulated webcam, library and clipboard.');
  } catch (error) {
    console.error('Original UI failure:', error);
    if (page) console.error('UI state:', await page.evaluate(() => ({ title: document.title, notice: document.querySelector('#notice')?.textContent, setupHidden: document.querySelector('#setup')?.hidden, workHidden: document.querySelector('#work')?.hidden, reviewHidden: document.querySelector('#review')?.hidden, text: document.body.innerText.slice(0, 3000) })));
    throw error;
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
