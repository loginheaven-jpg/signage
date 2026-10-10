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
    for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/sheets').then(r => r.ok, () => false)) break; await sleep(100); }
    assert.ok(fs.existsSync(path.join(root, 'schedule.before-sheets.json')), 'the old file is kept once');

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
    await page.goto(base + '/#schedule');
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
    await page.locator('#cueSave').click(); await toast('저장하고 모니터에 적용했습니다');
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

    // The saved file keeps rows an older server can still read.
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
    assert.deepEqual(saved.sheets.map(s => [s.siteId, s.name, s.type]), [['lobby', '기본', 'sync'], ['lobby', '주일용', 'separate'], ['dining', '식단', 'separate']]);
    assert.equal(saved.entries.filter(e => e.siteId === 'lobby').length, 3);
    assert.deepEqual(errors, []);
    console.log('Chromium cue sheets passed: old schedule kept as the default sheet, row waiting for a video on B, separate sheet with imported A/B lists, sound only for videos, timed and manual switching delivered to a player, save as, delete, one-monitor list, phone layout.');
  } finally {
    socket?.terminate(); if (browser) await browser.close();
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
