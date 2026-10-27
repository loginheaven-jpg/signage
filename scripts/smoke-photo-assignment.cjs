// Real administrator library UI + local Drive double, including 95 originals across pages.
const { chromium } = require('../host/node_modules/@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('../host/node_modules/sharp');
const { startPreview } = require('./camera-preview.cjs');
(async () => {
  const preview = await startPreview(); let browser;
  try {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#58a' } }).png().toFile(preview.photo + '.png');
    for (let i = 0; i < 95; i++) preview.archive.enqueue({ id: 'unassigned-' + i, ts: Date.now() }, preview.photo + '.png', {}, { status: 'awaiting_target', splitUpload: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(preview.url + '/photos');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 40);
    await page.locator('#selectPage').click(); assert.equal(await page.locator('#selectionCount').textContent(), '40개 선택');
    await page.locator('#next').click(); await page.waitForFunction(() => document.querySelector('#page').textContent === '2 / 3' && document.querySelector('#grid').getAttribute('aria-busy') === 'false');
    await page.locator('#selectPage').click(); assert.equal(await page.locator('#selectionCount').textContent(), '80개 선택');
    await page.locator('#selectUnassigned').click(); await page.waitForFunction(() => document.querySelector('#selectionCount').textContent === '95개 선택');
    await page.locator('#assignSelected').click();
    await page.locator('#assignmentLink').fill('https://drive.google.com/drive/folders/event-2026?usp=drive_link');
    await page.locator('#previewAssignment').click();
    await page.waitForFunction(() => !document.querySelector('#confirmAssignment').disabled);
    assert.match(await page.locator('#assignmentState').textContent(), /배정 가능 95개/);
    assert.equal([...preview.archive.records.values()].filter(r => r.status === 'awaiting_target').length, 95, 'preview does not assign');
    await page.locator('#confirmAssignment').click();
    await page.waitForFunction(() => document.querySelector('#assignmentState').textContent.includes('95개 배정 접수'));
    assert.equal(await page.locator('#selectionCount').textContent(), '0개 선택');
    for (let i = 0; i < 10; i++) await preview.archive.cycle(true);
    assert.equal([...preview.archive.records.values()].filter(r => r.status === 'saved' && r.folderId === 'event-2026' && r.verifiedAt).length, 95);
    assert.ok([...preview.archive.records.values()].every(r => fs.existsSync(preview.archive.localPath(r))));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('95-photo administrator assignment passed: cross-page selection, folder link, preview, confirmation, verified Drive storage, retained originals, 320px layout.');
  } finally { if (browser) await browser.close(); await preview.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
