const cameraUI=require('./helpers/camera-ui.cjs');
// 화면 문구 고르기: 교회 공용 문구, 이 기기의 최근 문구, 행사명 단추. 로컬 가짜 Drive·모니터만 쓴다.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const enter = async mode => {
      await cameraUI.click(page, '#home'); await page.locator('#captureHome').waitFor();
      await cameraUI.click(page, '[data-mode=' + mode + ']');
      await cameraUI.fill(page, '#uploader', '김예봄');
      if (mode === 'archive') {
        await cameraUI.click(page, '#chooseFolder'); await cameraUI.click(page, '[data-folder-id=event-2026]');
        await page.locator('#folderDialog').waitFor({ state: 'hidden' });
      } else {
        await cameraUI.click(page, '#chooseSite'); await page.locator('#siteDialog').waitFor();
        await cameraUI.click(page, '[data-site-id=screen]'); await page.locator('#siteDialog').waitFor({ state: 'hidden' });
      }
      await cameraUI.click(page, '#useSettings'); await page.locator('#work').waitFor();
      if (mode === 'both') {
        await cameraUI.click(page, '#chooseFolder'); await cameraUI.click(page, '[data-folder-id=event-2026]');
        await page.locator('#folderDialog').waitFor({ state: 'hidden' }); await cameraUI.click(page, '#saveLocation');
      }
    };
    const send = async () => {
      await page.locator('#galleryInput').setInputFiles(preview.photo);
      await cameraUI.click(page, '#send');
      await page.waitForFunction(() => !busy && document.querySelector('#progress').textContent.includes('서버 접수 완료'));
    };
    const groups = async () => page.locator('#messageChips > div').evaluateAll(boxes => boxes.map(box => [box.querySelector('p').textContent, [...box.querySelectorAll('.messageChip')].map(b => b.textContent)]));

    await page.goto(preview.url + '/camera');
    await enter('both');
    await cameraUI.options(page);
    // The church phrases and the event name of the chosen folder (20260820목자컨퍼런스) are offered.
    assert.deepEqual(await groups(), [
      ['교회 공용 문구', ['예봄교회 잘 오셨습니다', '새가족을 환영합니다.', '꽃보다 고운 님을 환영합니다.', '2026년 어느 좋은 날 예봄교회에서']],
      ['행사명 넣기', ['목자컨퍼런스']]]);

    // One tap fills the caption; it is sent with the photo.
    await page.locator('.messageChip', { hasText: '새가족을 환영합니다.' }).click();
    assert.equal(await page.locator('#message').inputValue(), '새가족을 환영합니다.');
    assert.equal(await page.locator('.messageChip', { hasText: '새가족을 환영합니다.' }).getAttribute('aria-pressed'), 'true');
    await send();
    assert.equal(preview.published.at(-1).photo.message, '새가족을 환영합니다.');

    // A typed caption joins "recent" after it was sent; church phrases never do.
    await cameraUI.fill(page, '#message', '김예봄 집사님 생일 축하해요');
    await send();
    assert.equal(preview.published.at(-1).photo.message, '김예봄 집사님 생일 축하해요');
    await cameraUI.options(page);
    assert.equal(await page.locator('#message').inputValue(), '', 'the caption is cleared after sending unless "keep" is ticked');
    assert.deepEqual((await groups()).map(g => g[0]), ['교회 공용 문구', '최근에 쓴 문구', '행사명 넣기']);
    assert.deepEqual((await groups())[1][1], ['김예봄 집사님 생일 축하해요']);
    if (process.env.PHRASE_SHOT) await page.locator('#optionsDialog').screenshot({ path: process.env.PHRASE_SHOT });   // 화면 확인용

    // Recent captions stay on this phone after the app is reopened, and can be removed one by one.
    await page.reload(); await cameraUI.click(page, '#continueResume');
    await cameraUI.options(page);
    assert.deepEqual((await groups())[1][1], ['김예봄 집사님 생일 축하해요']);
    await page.locator('#messageChips .recentChip .messageChip').click();
    assert.equal(await page.locator('#message').inputValue(), '김예봄 집사님 생일 축하해요');
    await page.locator('[aria-label="최근 문구 지우기: 김예봄 집사님 생일 축하해요"]').click();
    assert.deepEqual((await groups()).map(g => g[0]), ['교회 공용 문구', '행사명 넣기']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('camera.recentMessages'))), []);

    // Saving to the church folder only has no caption, so no phrases either.
    await cameraUI.closeDialogs(page); await cameraUI.fill(page, '#message', '');
    await enter('archive');
    assert.equal(await page.locator('#messageChips').isHidden(), true);
    assert.deepEqual(errors, []);
    console.log('Chromium caption phrases passed: church phrases and event name offered, one tap fills the caption, sent captions remembered on this phone across reloads and removable, nothing shown for archive-only saving.');
  } finally {
    if (browser) await browser.close(); await preview.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
