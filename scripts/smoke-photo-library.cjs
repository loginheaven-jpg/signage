// Chromium -> actual library API -> local archive inventory -> filtered cards.
// All photos, video, and Drive folders are fixtures; no production services.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('../host/node_modules/@ffmpeg-installer/ffmpeg').path;
const { startPreview } = require('./camera-preview.cjs');

(async () => {
  const preview = await startPreview(); let browser;
  try {
    const clip = path.join(preview.root, 'library.webm');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=10', '-c:v', 'libvpx', '-b:v', '200k', clip]);
    preview.remote.get('event-2026').name = '가을소풍';
    preview.folder('event-duplicate', '가을소풍', 'year-2026');
    preview.folder('year-2025', '2025', 'root'); preview.folder('event-2025', '봄소풍', 'year-2025');
    preview.folder('year-2024', '2024', 'root'); preview.folder('event-empty', '소풍 준비', 'year-2024');
    preview.folder('year-copy', '2026', 'root'); preview.folder('event-copy', '동명 연도 행사', 'year-copy');
    const target = { year: '2026', yearId: 'year-2026', eventId: 'event-2026', eventName: '가을소풍' };
    const add = (id, extra = {}, video = false) => preview.archive.enqueue({ id, message: id, ts: Date.parse('2026-10-10T03:00:00Z') }, video ? clip : preview.photo, {}, extra);
    for (let i = 0; i < 45; i++) add('outing-' + i, { target });
    add('outing-video', { target }, true);
    add('other-folder', { target: { ...target, eventId: 'event-duplicate' } });
    add('old-year', { target: { year: '2025', yearId: 'year-2025', eventId: 'event-2025', eventName: '봄소풍' } });
    add('root-photo'); add('root-video', {}, true); add('awaiting-photo', { status: 'awaiting_target' });
    await preview.archive.importFiles();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/api/photos') && response.status() >= 400) failed.push(response.status()); });
    const count = text => page.waitForFunction(text => document.querySelector('#count').textContent === text && document.querySelector('#grid').getAttribute('aria-busy') === 'false', text);
    await page.goto(preview.url + '/photos'); await count('사진 49장 · 영상 2개');
    assert.equal(await page.locator('.card').count(), 40);
    assert.equal(await page.locator('#chooseEvent').isDisabled(), true);
    assert.deepEqual(await page.locator('#year option').evaluateAll(options => options.map(option => option.value)), ['', 'year-2026', 'year-copy', 'year-2025', 'year-2024', '__root__', '__awaiting__']);
    await page.locator('#folderSearch').fill('소풍');
    assert.equal(await page.locator('#folderSearchList button').count(), 4, 'global search includes other years and empty Drive folders');
    assert.ok((await page.locator('#folderSearchList').textContent()).includes('2025 › 봄소풍'));
    await page.locator('[data-folder-id="event-empty"]').click(); await count('사진 0장 · 영상 0개');
    assert.equal(await page.locator('#year').inputValue(), 'year-2024');
    assert.equal(await page.locator('#eventChoiceText').textContent(), '소풍 준비', 'empty folders remain valid selections');
    assert.equal(await page.locator('#folderSearch').inputValue(), '');
    await page.locator('#resetFilters').click(); await count('사진 49장 · 영상 2개');
    await page.selectOption('#year', 'year-copy'); await count('사진 0장 · 영상 0개');
    await page.locator('#chooseEvent').click();
    assert.equal(await page.locator('[data-event-id="event-copy"]').count(), 1, 'duplicate year folders have separate event menus');
    await page.locator('#closeEvents').click();
    await page.selectOption('#year', 'year-2026'); await count('사진 46장 · 영상 1개');
    await page.locator('#folderSearch').fill('소풍');
    assert.equal(await page.locator('#folderSearchList button').count(), 2, 'selected year constrains global search');
    await page.locator('#clearFolderSearch').click();
    assert.equal(await page.locator('#folderSearchResults').isVisible(), false);
    await page.locator('#chooseEvent').click(); await page.locator('#eventSearch').fill('소풍');
    assert.equal(await page.locator('#eventList [data-event-id]').count(), 3, 'all plus two same-name folders');
    assert.ok((await page.locator('#eventList').textContent()).includes('동명 폴더 2'));
    await page.locator('[data-event-id="event-2026"]').click(); await count('사진 45장 · 영상 1개');
    assert.ok((await page.locator('#folderPath').textContent()).includes('가을소풍'));
    await page.locator('[data-kind=photo]').click(); await count('사진 45장 · 영상 0개');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#page').textContent === '2 / 2' && document.querySelector('#grid').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.card').count(), 5);
    await page.reload(); await count('사진 45장 · 영상 0개');
    assert.equal(await page.locator('#year').inputValue(), 'year-2026');
    assert.equal(await page.locator('#page').textContent(), '1 / 2');
    await page.locator('[data-kind=video]').click(); await count('사진 0장 · 영상 1개');
    assert.equal(await page.locator('#grid video').count(), 1);
    await page.locator('#dateSummary').click(); await page.locator('#date').fill('2026-01-01');
    await count('사진 0장 · 영상 0개'); assert.equal(await page.locator('.empty').count(), 1);
    assert.ok((await page.locator('#eventChoiceText').textContent()).includes('가을소풍'));
    await page.locator('#all').click(); await count('사진 0장 · 영상 1개');
    await page.selectOption('#year', 'year-2025'); await count('사진 0장 · 영상 0개');
    assert.equal(await page.locator('#eventChoiceText').textContent(), '전체 행사');
    await page.locator('[data-kind=""]').click(); await count('사진 1장 · 영상 0개');
    await page.selectOption('#year', '__root__'); await count('사진 1장 · 영상 1개');
    assert.equal(await page.locator('#chooseEvent').isDisabled(), true);
    await page.selectOption('#year', '__awaiting__'); await count('사진 1장 · 영상 0개');
    assert.ok((await page.locator('#grid').textContent()).includes('awaiting-photo'));
    await page.locator('#resetFilters').click(); await count('사진 49장 · 영상 2개');
    await page.selectOption('#year', 'year-2026'); await count('사진 46장 · 영상 1개');
    await page.locator('#chooseEvent').click(); await page.locator('#eventSearch').fill('소풍');
    await page.locator('[data-event-id="event-duplicate"]').click(); await count('사진 1장 · 영상 0개');
    assert.ok((await page.locator('#grid').textContent()).includes('other-folder'));
    // Removing a selected folder must show empty results, not quietly broaden to all photos.
    preview.archive.records.get('other-folder').status = 'missing';
    preview.remote.get('event-duplicate').trashed = true;
    await preview.archive.importFiles();
    await page.reload(); await count('사진 0장 · 영상 0개');
    assert.ok((await page.locator('#eventChoiceText').textContent()).includes('폴더 확인 필요'));
    await page.locator('#folderPath button').last().click(); await count('사진 45장 · 영상 1개');
    const output = path.resolve(__dirname, '../out/photo-library'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: false });
    await page.locator('#folderPath button').first().click(); await count('사진 48장 · 영상 2개');
    await page.locator('#folderSearch').fill('소풍');
    await page.screenshot({ path: path.join(output, 'folder-search.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.filters').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: false });
    await page.locator('[data-folder-id="event-2026"]').click(); await count('사진 45장 · 영상 1개');
    await page.locator('#chooseEvent').click(); await page.locator('#eventSearch').fill('없음');
    assert.equal(await page.locator('.event-empty').textContent(), '검색한 행사가 없습니다.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'event-picker.png'), fullPage: false });
    // A focused native search input consumes Escape to clear its query first.
    await page.locator('#closeEvents').focus();
    await page.keyboard.press('Escape'); await page.locator('#eventDialog').waitFor({ state: 'hidden' });
    // Actual remote media: keep the same IDs through a year/event rename and file move.
    preview.remote.set('synced-photo', { id: 'synced-photo', name: 'synced.png', mimeType: 'image/png', parents: ['event-2026'],
      description: '드라이브 이동 사진', createdTime: '2026-10-10T03:00:00Z', bytes: fs.readFileSync(preview.photo) });
    await preview.archive.importFiles();
    await page.reload(); await count('사진 46장 · 영상 1개');
    preview.remote.get('year-2026').name = '2028'; preview.remote.get('event-2026').name = '변경된 소풍';
    await preview.archive.importFiles();
    await page.reload(); await count('사진 46장 · 영상 1개');
    assert.equal(await page.locator('#year').inputValue(), 'year-2026');
    assert.equal(await page.locator('#eventChoiceText').textContent(), '변경된 소풍');
    assert.ok((await page.locator('#folderPath').textContent()).includes('2028'));
    assert.ok((await page.locator('#grid').textContent()).includes('변경된 소풍'));
    preview.remote.get('synced-photo').parents = ['event-2025'];
    await preview.archive.importFiles();
    await page.reload(); await count('사진 45장 · 영상 1개');
    await page.locator('#resetFilters').click(); await count('사진 49장 · 영상 2개');
    await page.locator('#folderSearch').fill('봄');
    assert.ok((await page.locator('#folderSearchList').textContent()).includes('사진 2장 · 영상 0개'));
    await page.locator('[data-folder-id="event-2025"]').click(); await count('사진 2장 · 영상 0개');
    assert.ok((await page.locator('#grid').textContent()).includes('드라이브 이동 사진'));
    // A cold folder cache must populate while a separate full-media scan is held.
    let mediaStarted, releaseMedia;
    const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
    const started = new Promise(resolve => { mediaStarted = resolve; });
    const remoteList = preview.drive.files.list;
    preview.drive.files.list = async (...args) => {
      if (args[0].q.includes('mimeType contains')) { mediaStarted(); await mediaGate; }
      return remoteList(...args);
    };
    preview.archive.folderCatalog = { rootId: 'root', checkedAt: 0, years: [] };
    const mediaScan = preview.archive.importFiles();
    await started; // Its folder-only phase is already published; media stays blocked.
    try {
      await page.reload(); await count('사진 2장 · 영상 0개');
      assert.equal(await page.locator('#year option[value="year-2025"]').count(), 1);
      await page.locator('#chooseEvent').click();
      assert.equal(await page.locator('[data-event-id="event-2025"]').count(), 1);
      await page.locator('#closeEvents').click();
    } finally { releaseMedia(); await mediaScan; }
    // Cached navigation is returned before an explicitly requested Drive refresh finishes.
    let foldersStarted, releaseFolders;
    const folderGate = new Promise(resolve => { releaseFolders = resolve; });
    const folderStarted = new Promise(resolve => { foldersStarted = resolve; });
    preview.drive.files.list = async (...args) => {
      if (args[0].q.includes("mimeType = '")) { foldersStarted(); await folderGate; }
      return remoteList(...args);
    };
    const refresh = page.request.get(preview.url + '/api/photos/folders?refresh=1');
    await folderStarted;
    try {
      const cached = await (await refresh).json();
      assert.equal(cached.refreshing, true);
      assert.ok(cached.years.some(group => group.id === 'year-2025'));
      await page.reload(); await count('사진 2장 · 영상 0개');
      assert.ok((await page.locator('#folderNotice').textContent()).includes('최신 목록'));
    } finally { releaseFolders(); await preview.archive.folderBrowser.pending; }
    preview.drive.files.list = remoteList;
    assert.deepEqual(errors, []); assert.deepEqual(failed, []);
    console.log('Library Chromium passed: actual/empty Drive folders, duplicate year IDs, global/per-year search, pagination, reload memory, desktop/mobile, Drive renames/moves, folders usable during a blocked media scan, cached navigation during a blocked Drive refresh. Screenshots: ' + output);
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
