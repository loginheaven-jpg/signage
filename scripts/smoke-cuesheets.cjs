// Admin cue sheet page against the real server: an old schedule becomes the default sheet,
// editing, save as, a new "separate" sheet with imported items, timed and manual switching
// reaching a connected player, and the phone layout. Local files only.
const { chromium } = require('../host/node_modules/@playwright/test');
const WebSocket = require('../host/node_modules/ws');
const sharp = require('../host/node_modules/sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-cuesheets-'));
  const uploads = path.join(root, 'uploads'); fs.mkdirSync(uploads);
  const long = '2026_추수감사주일_연합예배_안내포스터_최종수정본.jpg';
  for (const name of ['cover.jpg', 'guide.jpg', 'notice.jpg', long]) await sharp({ create: { width: 64, height: 36, channels: 3, background: '#557' } }).jpeg().toFile(path.join(uploads, name));
  fs.writeFileSync(path.join(uploads, 'clip.mp4'), 'not played here');
  const content = ['cover.jpg', 'guide.jpg', 'notice.jpg', long, 'clip.mp4'].map((name, i) => ({ id: 'c' + i, originalName: name, filename: name, size: 1, mimeType: name.endsWith('mp4') ? 'video/mp4' : 'image/jpeg', source: 'local', uploadedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(root, 'content.json'), JSON.stringify(content));
  fs.writeFileSync(path.join(root, 'sites.json'), JSON.stringify([{ id: 'lobby', name: '로비', icon: '', monitors: 2, description: '' }, { id: 'dining', name: '식당', icon: '', monitors: 1, description: '' }]));
  // The schedule as an older server wrote it.
  const row = { siteId: 'lobby', layoutType: 'independent', audio: 'none', transition: 'fade', validFrom: null, validTo: null, enabled: true, videoDuration: 'original' };
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify({ version: 1, entries: [
    { ...row, file1: 'cover.jpg', file1Mime: 'image/jpeg', file2: 'guide.jpg', file2Mime: 'image/jpeg', duration: 10 },
    { ...row, file1: long, file1Mime: 'image/jpeg', file2: '', duration: 15 } ] }));
  fs.writeFileSync(path.join(root, 'approved-clients.json'), JSON.stringify({ player: { name: '로비', siteId: 'lobby', approvedAt: new Date().toISOString() } }));

  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '../host'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: root, UPLOADS_DIR: uploads, ADMIN_PASSWORD: '', CAMERA_PASSWORD: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', GDRIVE_FOLDER_ID: 'test' } });
  let logs = ''; server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  let browser, socket;
  try {
    for (let i = 0; i < 200; i++) { if (await fetch(base + '/api/sheets').then(r => r.ok, () => false)) break; if (server.exitCode !== null) break; await sleep(100); }
    assert.ok(fs.existsSync(path.join(root, 'schedule.before-sheets.json')), 'the old file is kept once\n' + logs.slice(-3000));

    // A connected player for 로비 that records what it is told to play.
    const received = [];
    socket = new WebSocket(base.replace('http', 'ws'));
    socket.on('message', b => { const m = JSON.parse(b); if (m.type === 'schedule_update') received.push(m.schedule); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'register', clientId: 'player', name: '로비', monitors: 2 }));
    const latest = async test => { for (let i = 0; i < 60; i++) { if (received.length && test(received.at(-1))) return received.at(-1); await sleep(100); } assert.fail('player did not receive the expected sheet: ' + JSON.stringify(received.at(-1)) + '\n' + logs.slice(-1500)); };
    await latest(s => s.name === '기본' && s.mode === 'sync' && s.entries.length === 2);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    // The client response used to render an empty site list and stay there when sites arrived later.
    let releaseSites;
    const sitesGate = new Promise(resolve => { releaseSites = resolve; });
    await page.route('**/api/sites', async route => {
      const response = await route.fetch();
      await sitesGate; await route.fulfill({ response });
    });
    await page.goto(base + '/#schedule');
    await page.waitForFunction(() => clientsData.length === 1);
    const loadingText = await page.locator('#clientList').textContent();
    releaseSites();
    assert.doesNotMatch(loadingText, /등록된 사이트가 없습니다|새로 접속한 클라이언트가 없습니다/);
    await page.locator('#clientList .cc-name', { hasText: '로비' }).waitFor({ state: 'attached' });
    assert.match(await page.locator('#clientList').textContent(), /온라인/);
    await page.unroute('**/api/sites');
    await page.locator('#cueList .cue-sheet').first().waitFor();
    const toast = async text => page.waitForFunction(t => document.getElementById('toast').textContent.includes(t), text);

    // 1. The old schedule is the default sheet of 로비 and plays unchanged.
    assert.deepEqual(await page.locator('#cueSites .cue-tab').allTextContents(), ['로비모니터 2대', '식당모니터 1대']);
    assert.equal(await page.locator('#cueLiveName').textContent(), '기본');
    assert.match(await page.locator('#cueList').textContent(), /기본.*적용 중.*함께 넘기기.*기본 \(다른 큐시트 시간이 아닐 때\)/s);
    assert.equal(await page.locator('#cueRows tbody tr').count(), 2);
    assert.equal(await page.locator('#cueRows tbody tr').nth(1).locator('td.name').nth(1).textContent().then(t => t.includes('비움 (검은 화면)')), true);
    // No video in a row: the sound choice is off.
    assert.equal(await page.locator('#cueRows tbody tr').first().locator('select[aria-label=소리]').isDisabled(), true);

    // 2. Add a row whose B side is a video and let the row last until it ends (time 0).
    await page.locator('#cueAddRow').click();
    const third = page.locator('#cueRows tbody tr').nth(2);
    await third.locator('select.cue-pick').first().selectOption('notice.jpg');
    await third.locator('select.cue-pick').nth(1).selectOption('clip.mp4');
    assert.deepEqual(await third.locator('select[aria-label=소리] option').allTextContents(), ['없음', 'B'], 'sound can only come from the side that is a video');
    await third.locator('input[aria-label="시간(초)"]').fill('0'); await third.locator('input[aria-label="시간(초)"]').blur();
    assert.match(await third.textContent(), /영상 끝까지/);
    // The same buttons sit above the list, so a long sheet needs no scrolling to save.
    assert.deepEqual(await page.locator('#cueEditor button[id$=Top]').allTextContents(), ['다른 이름으로 저장', '저장 및 적용']);
    await page.locator('#cueSaveTop').click(); await toast('저장하고 모니터에 적용했습니다');
    const waited = await latest(s => s.entries.length === 3);
    assert.deepEqual([waited.entries[2].filename, waited.entries[2].filename2, waited.entries[2].duration], ['notice.jpg', 'clip.mp4', 0]);

    // 3. A new "separate" sheet importing left → A and right → B.
    await page.locator('#cueNewButton').click();
    await page.locator('#cueNewName').fill('주일용');
    await page.locator('.cue-type[data-type=separate]').click();
    assert.equal(await page.locator('#cueNewName').inputValue(), '주일용', 'choosing the type keeps the typed name');
    await page.locator('#cueImport').selectOption({ index: 1 });
    await page.locator('#cueCreate').click(); await toast('큐시트를 만들었습니다');
    assert.equal(await page.locator('table[data-list=a] tbody tr').count(), 3);
    assert.equal(await page.locator('table[data-list=b] tbody tr').count(), 2);
    assert.equal(await page.locator('#cueLiveName').textContent(), '기본', 'a new sheet does not go on air by itself');
    // Sound: only the video can be ticked.
    assert.equal(await page.locator('table[data-list=b] tbody tr').first().locator('input[aria-label^=소리]').isDisabled(), true);
    const clip = page.locator('table[data-list=b] tbody tr').nth(1);
    assert.match(await clip.textContent(), /clip\.mp4.*영상 길이/s);
    await clip.locator('input[aria-label^=소리]').check();
    await page.locator('#cueSave').click(); await toast('모니터에는 영향이 없습니다');
    assert.equal(received.at(-1).name, '기본');

    // 4. A time rule covering now switches automatically; the player gets both lists.
    const today = new Date(Date.now() + 9 * 3600000).getUTCDay();
    await page.locator('#cueAddWeek').click();
    const dayButtons = page.locator('.cue-rule .cue-day');   // 월 화 수 목 금 토 일
    const order = [1, 2, 3, 4, 5, 6, 0];
    if (today !== 0) { await dayButtons.nth(order.indexOf(today)).click(); await dayButtons.nth(6).click(); }
    await page.locator('#cueRuleFrom0').fill('00:00'); await page.locator('#cueRuleTo0').fill('23:59'); await page.locator('#cueRuleTo0').blur();
    await page.locator('#cueSave').click(); await toast('저장');
    const separate = await latest(s => s.mode === 'separate');
    assert.equal(separate.name, '주일용');
    assert.deepEqual(separate.entries.map(e => e.filename), ['cover.jpg', long, 'notice.jpg']);
    assert.deepEqual(separate.entriesB.map(e => [e.filename, e.duration, e.sound]), [['guide.jpg', 10, 'none'], ['clip.mp4', 0, 'left']]);
    await page.waitForFunction(() => document.getElementById('cueLiveName').textContent === '주일용');
    assert.match(await page.locator('#cueNow').textContent(), /자동 전환 중/);
    assert.equal(await page.locator('.cue-bar i').count() > 7, true, 'the week timetable shows the rule');

    // 5. Switching by hand pins the sheet; returning to automatic follows the timetable again.
    await page.locator('#cueList .cue-sheet', { hasText: '기본' }).click();
    await page.locator('#cuePin').click(); await toast('전환했습니다');
    await latest(s => s.name === '기본');
    assert.match(await page.locator('#cueNow').textContent(), /수동 고정.*자동 전환을 멈췄습니다/s);
    await page.locator('#cueUnpin').click(); await toast('자동 전환으로 돌아갔습니다');
    await latest(s => s.name === '주일용');

    // 6. Save as: a copy under a new name, without the time rule; the original stays.
    await page.locator('#cueList .cue-sheet', { hasText: '주일용' }).click();
    if (process.env.CUESHEET_SHOT) await page.screenshot({ path: process.env.CUESHEET_SHOT, fullPage: true });   // 화면 확인용
    await page.locator('#cueSaveAsOpen').click();
    await page.locator('#cueSaveAsName').fill('성탄행사'); await page.locator('#cueSaveAsDo').click(); await toast('새 큐시트로 저장했습니다');
    assert.equal(await page.locator('#cueList .cue-sheet').count(), 3);
    assert.match(await page.locator('#cueList .cue-sheet', { hasText: '성탄행사' }).textContent(), /적용 시간 없음/);
    assert.equal(await page.locator('table[data-list=b] tbody tr').count(), 2);
    await page.locator('#cueDelete').click(); await toast('큐시트를 지웠습니다');
    assert.equal(await page.locator('#cueList .cue-sheet').count(), 2);
    assert.equal(received.at(-1).name, '주일용');

    // 7. A one-monitor place gets a single list and no type choice.
    await page.locator('#cueSites .cue-tab', { hasText: '식당' }).click();
    assert.match(await page.locator('#cueNow').textContent(), /아직 큐시트가 없습니다/);
    await page.locator('#cueNewButton').click();
    assert.equal(await page.locator('.cue-type').count(), 0);
    await page.locator('#cueNewName').fill('식단'); await page.locator('#cueCreate').click(); await toast('큐시트를 만들었습니다');
    assert.equal(await page.locator('table[data-list]').count(), 1);
    assert.equal(await page.locator('[data-copy]').count(), 0, 'a single monitor has no A to B action');
    await page.locator('[data-add=a]').click();
    await page.locator('table[data-list=a] select.cue-pick').selectOption(long);
    await page.locator('#cueSave').click(); await toast('저장하고 모니터에 적용했습니다');

    // 8. Phone width: no sideways scrolling and the long file name is fully visible.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cueSites .cue-tab', { hasText: '로비' }).click();
    await page.locator('#cueList .cue-sheet', { hasText: '기본' }).click();
    const name = page.locator('#cueRows .cue-fn', { hasText: '추수감사주일' });
    assert.equal(await name.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'the long name is not cut off');
    assert.equal(await page.locator('.content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'the page body does not scroll sideways');

    // 9. Shift-copy previews before replacing B, can be cancelled or undone, and reaches the player after saving.
    await page.setViewportSize({ width: 1280, height: 900 });
    const syncRows = page.locator('#cueRows tbody tr');
    const syncBefore = await page.evaluate(() => JSON.parse(JSON.stringify(cueDraft.rows)));
    await page.locator('[data-copy=rows]').click();
    await page.locator('#cueCopyDialog').waitFor();
    assert.deepEqual(await page.locator('#cueCopyDialog tbody tr td:last-child').allTextContents(), ['notice.jpg', 'cover.jpg', long]);
    await page.locator('#cueCopyDialog button', { hasText: '취소' }).click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows), syncBefore);
    await syncRows.nth(0).locator('[data-select=rows]').check();
    await syncRows.nth(2).locator('[data-select=rows]').check();
    await page.locator('[data-copy=rows]').click();
    await page.locator('#cueConfirmCopy').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file2)), ['notice.jpg', '', 'cover.jpg']);
    assert.equal(await page.evaluate(() => cueDraft.rows[2].audio), 'none', 'a copied photo cannot retain sound from the replaced B video');
    await page.locator('#cueUndoCopy').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows), syncBefore);
    await page.locator('[data-copy=rows]').click();
    await page.locator('#cueConfirmCopy').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file2)), ['notice.jpg', 'cover.jpg', long]);
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file1)), syncBefore.map(r => r.file1));
    await page.locator('#cueSave').click(); await toast('저장');
    await page.reload();
    await page.locator('#cueList .cue-sheet', { hasText: '기본' }).click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file2)), ['notice.jpg', 'cover.jpg', long]);
    await page.locator('#cuePin').click(); await toast('전환했습니다');
    const copied = await latest(s => s.name === '기본' && s.entries[0]?.filename2 === 'notice.jpg');
    assert.deepEqual(copied.entries.map(r => r.filename2), ['notice.jpg', 'cover.jpg', long]);
    await page.locator('#cueUnpin').click(); await latest(s => s.name === '주일용');

    // 10. A multi-selection keeps relative order, survives passive refresh, and follows moved/deleted rows.
    await syncRows.nth(0).locator('[data-select=rows]').check();
    await syncRows.nth(2).locator('[data-select=rows]').check();
    await page.evaluate(() => refreshSchedule());
    assert.equal(await page.locator('[data-select=rows]:checked').count(), 2);
    await page.locator('[data-bulk=rows] [data-move=top]').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file1)), ['cover.jpg', 'notice.jpg', long]);
    await page.locator('[data-bulk=rows] [data-move=bottom]').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.rows.map(r => r.file1)), [long, 'cover.jpg', 'notice.jpg']);
    assert.equal(await page.locator('[data-select=rows]:checked').count(), 2);
    await syncRows.nth(1).locator('[aria-label=위로]').click();
    assert.equal(await syncRows.nth(0).locator('[data-select=rows]').isChecked(), true);
    await syncRows.nth(0).locator('[aria-label=삭제]').click();
    assert.equal(await page.locator('[data-select=rows]:checked').count(), 1);
    await page.locator('[data-bulk=rows] [aria-label="전체 선택"]').check();
    assert.equal(await page.locator('[data-select=rows]:checked').count(), 2);
    await page.locator('[data-bulk=rows] [aria-label="전체 선택"]').uncheck();
    assert.equal(await page.locator('[data-bulk=rows] [data-move=top]').isDisabled(), true);
    // Unsaved changes are discarded on switching; list selections are isolated per sheet.
    await page.locator('#cueList .cue-sheet', { hasText: '주일용' }).click();
    assert.equal(await page.locator('[data-select]:checked').count(), 0);
    await page.locator('table[data-list=a] tbody tr').nth(1).locator('[data-select=a]').check();
    await page.locator('[data-bulk=a] [data-move=top]').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.a.map(r => r.file)), [long, 'cover.jpg', 'notice.jpg']);
    assert.equal(await page.locator('[data-bulk=b] [data-move=top]').isDisabled(), true);
    await page.locator('[data-bulk=a] [data-move=bottom]').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.a.map(r => r.file)), ['cover.jpg', 'notice.jpg', long]);
    await page.locator('#cueSave').click(); await toast('저장');
    await page.reload();
    await page.locator('#cueList .cue-sheet', { hasText: '주일용' }).click();
    assert.deepEqual(await page.evaluate(() => cueDraft.a.map(r => r.file)), ['cover.jpg', 'notice.jpg', long]);

    // Separate mode copies selected complete items, including video settings, without changing A.
    const aRows = page.locator('table[data-list=a] tbody tr');
    await aRows.nth(2).locator('select.cue-pick').selectOption('clip.mp4');
    await aRows.nth(2).locator('[aria-label="시간(초)"]').fill('23');
    await aRows.nth(2).locator('[aria-label="시간(초)"]').blur();
    await aRows.nth(2).locator('[aria-label=소리]').check();
    await aRows.nth(2).locator('[aria-label=시작일]').fill('2026-01-01');
    await aRows.nth(2).locator('[aria-label=시작일]').blur();
    await aRows.nth(0).locator('[data-select=a]').check();
    await aRows.nth(2).locator('[data-select=a]').check();
    const aBefore = await page.evaluate(() => JSON.parse(JSON.stringify(cueDraft.a)));
    const bBefore = await page.evaluate(() => JSON.parse(JSON.stringify(cueDraft.b)));
    await aRows.nth(0).locator('[data-select=a]').uncheck();
    await page.locator('[data-copy=a]').click();
    assert.deepEqual(await page.locator('#cueCopyDialog tbody tr td:last-child').allTextContents(), ['clip.mp4', '목록에서 제외'], 'preview includes B items that will be removed by a shorter copy');
    await page.locator('#cueCopyDialog button', { hasText: '취소' }).click();
    await aRows.nth(0).locator('[data-select=a]').check();
    await page.locator('[data-copy=a]').click();
    await page.locator('#cueConfirmCopy').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.a), aBefore);
    assert.deepEqual(await page.evaluate(() => cueDraft.b), [aBefore[2], aBefore[0]]);
    await page.locator('#cueUndoCopy').click();
    assert.deepEqual(await page.evaluate(() => cueDraft.b), bBefore);
    await page.locator('[data-copy=a]').click();
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.locator('#cueCopyDialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    assert.equal(await page.locator('#cueCopyDialog').evaluate(el => Math.abs(el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2 - innerWidth / 2) < 2), true, 'the copy dialog is centered even with the global CSS reset');
    if (process.env.CUESHEET_SHOT) await page.screenshot({ path: process.env.CUESHEET_SHOT.replace(/\.png$/, '-copy.png') });
    await page.locator('#cueConfirmCopy').click();
    assert.equal(await page.locator('.content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    if (process.env.CUESHEET_SHOT) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: process.env.CUESHEET_SHOT.replace(/\.png$/, '-selection.png'), fullPage: true });
    }
    await page.locator('#cueSave').click(); await toast('저장');
    const copiedSeparate = await latest(s => s.name === '주일용' && s.entriesB[0]?.filename === 'clip.mp4' && s.entriesB[0]?.duration === 23);
    assert.deepEqual(copiedSeparate.entriesB.map(r => r.filename), ['clip.mp4', 'cover.jpg', 'notice.jpg']);
    assert.equal(copiedSeparate.entriesB[0].sound, 'left');
    await page.reload();
    await page.locator('#cueList .cue-sheet', { hasText: '주일용' }).click();
    assert.deepEqual(await page.evaluate(() => cueDraft.b), [aBefore[2], aBefore[0], aBefore[1]]);

    // 11. Without websocket access HTTP still loads; failures keep the last snapshot and can be retried.
    const fallback = await browser.newPage();
    fallback.on('pageerror', error => errors.push(error.message));
    await fallback.routeWebSocket(/.*/, ws => ws.close({ code: 1013, reason: 'test unavailable' }));
    let failSites = true, failClients = false;
    await fallback.route('**/api/sites', route => failSites ? route.fulfill({ status: 503, json: { error: 'temporary' } }) : route.continue());
    await fallback.route('**/api/clients', route => failClients ? route.fulfill({ status: 200, json: { error: 'bad response' } }) : route.continue());
    await fallback.goto(base);
    await fallback.locator('#clientList', { hasText: '불러오지 못했습니다' }).waitFor();
    assert.doesNotMatch(await fallback.locator('#clientList').textContent(), /등록된 사이트가 없습니다/);
    failSites = false;
    await fallback.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await fallback.locator('#clientList .cc-name', { hasText: '로비' }).waitFor();
    failClients = true;
    await fallback.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await fallback.locator('#connectionNotice').waitFor();
    assert.match(await fallback.locator('#clientList').textContent(), /로비.*온라인/s);
    failClients = false;
    await fallback.evaluate(() => window.dispatchEvent(new Event('online')));
    await fallback.locator('#connectionNotice').waitFor({ state: 'hidden' });
    // No notification reaches this page; periodic HTTP refresh recovers the player's disconnection.
    socket.close();
    await fallback.locator('#clientList .cc-card .pill', { hasText: '오프라인' }).waitFor({ timeout: 22000 });
    await fallback.route('**/api/sites', route => route.fulfill({ json: [] }));
    await fallback.route('**/api/clients', route => route.fulfill({ json: [] }));
    await fallback.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await fallback.locator('#clientList', { hasText: '등록된 사이트가 없습니다' }).waitFor();
    assert.equal(await fallback.locator('#connectionNotice').isVisible(), false, 'a real empty response is different from a query failure');
    await fallback.close();

    // The saved file keeps rows an older server can still read.
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
    assert.deepEqual(saved.sheets.map(s => [s.siteId, s.name, s.type]), [['lobby', '기본', 'sync'], ['lobby', '주일용', 'separate'], ['dining', '식단', 'separate']]);
    assert.equal(saved.entries.filter(e => e.siteId === 'lobby').length, 3);
    assert.deepEqual(errors, []);
    console.log('Chromium cue sheets passed: migration, sync/separate playback, timing, pinning, save as, single monitor, selection and stable bulk moves, shift-copy preview/cancel/undo/save/reload/player delivery, 320px layout, delayed site loading, HTTP without websocket, failure retry and disconnected-client recovery.');
  } finally {
    socket?.terminate(); if (browser) await browser.close();
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
