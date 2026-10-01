const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { PhotoMail, normalizeEmail } = require('../host/photo-mail');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-mail-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('signage-mail-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

function fixture(t, { env = {}, fail = 0 } = {}) {
  const root = tempDir(t);
  const clock = { now: Date.parse('2026-10-01T03:00:00Z') };
  const sent = [];
  const transport = { sendMail: async message => {
    if (fail-- > 0) throw Object.assign(new Error('refused for guest@example.com'), { code: 'ECONNECTION' });
    // Attachments are read while sending, so the files must still exist at this point.
    for (const a of message.attachments) assert.ok(fs.existsSync(a.path), a.path);
    sent.push(message);
  } };
  const create = () => new PhotoMail({ dataDir: root, env, transport, now: () => clock.now });
  const mail = create();
  function add(email = 'guest@example.com', { uploaderId = 'u1', bytes = 'photo-content', message = '축하합니다' } = {}) {
    const source = path.join(root, randomUUID() + '.jpg'); fs.writeFileSync(source, bytes);
    const photo = { id: randomUUID(), message, ts: clock.now, uploaderId };
    const result = mail.enqueue({ photo, source, site: { id: 'site', name: '현관' }, email, delayMs: 60000 });
    fs.unlinkSync(source); // Exactly what live clear/TTL does; the promised mail must survive.
    return { photo, result };
  }
  const files = dir => fs.readdirSync(path.join(root, 'photo-mail', dir));
  return { root, clock, sent, mail, create, add, files };
}

// Minimal SMTP endpoint: enough of the protocol for nodemailer to log in and deliver one message.
async function smtpServer(t) {
  const mails = [];
  const server = net.createServer(socket => {
    let buffer = '', mail = { to: [] }, inData = false;
    const reply = line => socket.write(line + '\r\n');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push({ ...mail, raw: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5); mail = { to: [], auth: mail.auth }; inData = false;
          reply('250 queued');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^EHLO/i.test(line)) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) { mail.auth = Buffer.from(line.slice(11), 'base64').toString(); reply('235 ok'); }
        else if (/^MAIL FROM:/i.test(line)) { mail.from = line; reply('250 ok'); }
        else if (/^RCPT TO:/i.test(line)) { mail.to.push(line.slice(8).replace(/[<>]/g, '').trim()); reply('250 ok'); }
        else if (/^DATA/i.test(line)) { inData = true; reply('354 go'); }
        else if (/^QUIT/i.test(line)) { reply('221 bye'); socket.end(); }
        else reply('250 ok');
      }
    });
    reply('220 test ESMTP');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, mails };
}
const attachments = raw => (raw.match(/Content-Disposition: attachment/gi) || []).length;

test('only one plain address is accepted', () => {
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail('  Kim.Jisu@Gmail.COM '), 'Kim.Jisu@gmail.com');
  for (const bad of ['kim', 'kim@gmail', 'a@b.com, c@d.com', 'a@b.com;c@d.com', 'Kim <a@b.com>', 'a b@c.com',
    'a@b.com\r\nBcc: x@y.com', 'a@b..com', 'a@-b.com', '@b.com', 'x'.repeat(65) + '@b.com']) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test('photos sent within the cancel window travel as one mail, only after the window, and leave no address behind', async t => {
  const { clock, sent, mail, add, files } = fixture(t);
  const first = add(), second = add(), third = add();
  assert.deepEqual([first.result, second.result, third.result], ['queued', 'queued', 'queued']);
  assert.equal(files('jobs').length, 1);
  clock.now += 61000;
  await mail.cycle();
  assert.equal(sent.length, 0, 'the cancel window (plus margin) has not closed yet');
  assert.equal(mail.statusOf(first.photo.id), 'queued');
  clock.now += 2000;
  await mail.cycle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'guest@example.com');
  assert.equal(sent[0].attachments.length, 3);
  assert.match(sent[0].attachments[0].filename, /^photo_20261001_120000_1\.jpg$/, 'file name uses Korean time');
  assert.match(sent[0].text, /사진 3장/);
  assert.match(sent[0].text, /함께 올린 문구: 축하합니다/);
  assert.equal(sent[0].text.match(/함께 올린 문구/g).length, 1, 'a repeated message is listed once');
  assert.equal(mail.statusOf(third.photo.id), 'sent');
  assert.deepEqual([files('jobs'), files('media')], [[], []], 'address and mail copies are deleted after sending');
  assert.equal(mail.status().sentToday, 1);
  await mail.cycle();
  assert.equal(sent.length, 1, 'a delivered mail is never repeated');
});

test('different recipients or uploaders are never merged, and oversized batches are split', async t => {
  const { clock, sent, mail, add } = fixture(t);
  add('a@example.com'); add('b@example.com'); add('a@example.com', { uploaderId: 'u2' });
  const big = Buffer.alloc(10 * 1024 * 1024);
  add('big@example.com', { bytes: big }); add('big@example.com', { bytes: big });
  clock.now += 63000;
  await mail.cycle();
  assert.deepEqual(sent.map(m => `${m.to}:${m.attachments.length}`).sort(),
    ['a@example.com:1', 'a@example.com:1', 'b@example.com:1', 'big@example.com:1', 'big@example.com:1']);
});

test('cancelled photos are removed from the pending mail; only the owner can cancel the mail', async t => {
  const { clock, sent, mail, add, files } = fixture(t);
  const keep = add(), drop = add(), alone = add('other@example.com');
  assert.equal(mail.remove(drop.photo.id, 'someone-else'), false);
  assert.equal(mail.remove(drop.photo.id, 'u1'), true);
  assert.equal(mail.remove(drop.photo.id, 'u1'), false, 'already removed');
  assert.equal(mail.remove(alone.photo.id), true, 'server-side removal needs no uploader');
  assert.equal(files('jobs').length, 1, 'an emptied mail is deleted together with its address');
  assert.equal(files('media').length, 1);
  clock.now += 63000;
  await mail.cycle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(mail.statusOf(keep.photo.id), 'sent');
  assert.equal(mail.statusOf(drop.photo.id), 'cancelled');
  assert.equal(mail.statusOf(alone.photo.id), 'cancelled');
  assert.equal(mail.remove(keep.photo.id, 'u1'), false, 'a sent mail cannot be cancelled');
});

test('failures retry with backoff across restarts, then give up and delete the address', async t => {
  const { clock, sent, mail, create, add, files } = fixture(t, { fail: 1 });
  const { photo } = add();
  clock.now += 63000;
  await mail.cycle();
  assert.equal(sent.length, 0);
  assert.equal(mail.statusOf(photo.id), 'queued');
  assert.doesNotMatch(mail.status().error, /guest@example\.com/, 'the status never exposes the recipient');
  assert.notEqual(mail.status().error, '');
  await mail.cycle();
  assert.equal(sent.length, 0, 'not retried before the backoff time');
  assert.equal(add().result, 'queued');
  assert.equal(files('jobs').length, 2, 'a mail that already failed takes no more photos');
  const restarted = create();
  assert.equal(restarted.statusOf(photo.id), 'queued', 'the queue survives a restart');
  clock.now += 63000;
  await restarted.cycle();
  assert.equal(sent.length, 2);
  assert.equal(restarted.status().error, '');

  const broken = fixture(t, { fail: 99 });
  const lost = broken.add();
  broken.clock.now += 63000;
  for (let i = 0; i < 6; i++) { await broken.mail.cycle(); broken.clock.now += 1800000; }
  assert.equal(broken.mail.statusOf(lost.photo.id), 'failed');
  assert.deepEqual([broken.files('jobs'), broken.files('media')], [[], []]);
});

test('the daily limit and a missing mail account stop new mails without touching the upload', t => {
  const limited = fixture(t, { env: { MAIL_DAILY_LIMIT: '2' } });
  assert.equal(limited.add('a@example.com').result, 'queued');
  assert.equal(limited.add('b@example.com').result, 'queued');
  assert.equal(limited.add('c@example.com').result, 'limit');
  assert.equal(limited.add('a@example.com').result, 'queued', 'joining a mail that is already counted is allowed');
  const root = tempDir(t);
  const off = new PhotoMail({ dataDir: root, env: {} });
  assert.equal(off.configured, false);
  assert.equal(off.enqueue({ photo: { id: 'x' }, source: 'x.jpg', site: {}, email: 'a@example.com', delayMs: 0 }), 'off');
});

test('real SMTP delivery: login, a single recipient and the photo attachment', async t => {
  const smtp = await smtpServer(t);
  const root = tempDir(t);
  const clock = { now: Date.now() };
  const mail = new PhotoMail({ dataDir: root, now: () => clock.now,
    env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'church@example.com', SMTP_PASS: 'app-password', MAIL_FROM_NAME: '예봄교회' } });
  t.after(() => mail.transport?.close());
  const source = path.join(root, 'shot.jpg'); fs.writeFileSync(source, 'jpeg-bytes-for-mail');
  assert.equal(mail.enqueue({ photo: { id: randomUUID(), message: '생일 축하', ts: clock.now, uploaderId: 'u1' }, source,
    site: { id: 'site', name: '현관' }, email: 'guest@example.com', delayMs: 0 }), 'queued');
  clock.now += 3000;
  await mail.cycle();
  assert.equal(mail.status().error, '');
  assert.equal(smtp.mails.length, 1);
  assert.deepEqual(smtp.mails[0].to, ['guest@example.com']);
  assert.match(smtp.mails[0].auth, /church@example\.com\0app-password$/);
  assert.match(smtp.mails[0].from, /church@example\.com/);
  assert.equal(attachments(smtp.mails[0].raw), 1);
  assert.ok(smtp.mails[0].raw.includes(Buffer.from('jpeg-bytes-for-mail').toString('base64')));
});

test('real server: address validation, mail-only cancel, photo cancel, and delivery after the cancel window', { timeout: 40000 }, async t => {
  const smtp = await smtpServer(t);
  const temp = tempDir(t);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '../host'), windowsHide: true,
    env: { ...process.env, PORT: String(port), DATA_DIR: temp, UPLOADS_DIR: path.join(temp, 'uploads'),
      ADMIN_PASSWORD: '', CAMERA_PASSWORD: '', NODE_ENV: '', RAILWAY_ENVIRONMENT_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', GDRIVE_FOLDER_ID: 'test',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'church@example.com', SMTP_PASS: 'app-password', MAIL_FROM: '', MAIL_DAILY_LIMIT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  });
  async function api(route, method = 'GET', body) {
    const res = await fetch(base + route, { method,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  }
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await api('/api/sites'); up = true; break; } catch (e) { await sleep(100); }
  }
  assert.ok(up, logs);
  const { site } = (await api('/api/sites', 'POST', { name: 'test-display' })).body;
  await api('/api/live', 'PUT', { enabled: true, settings: { cancelSec: 10 } });
  const { token } = (await api('/api/live')).body;
  assert.equal((await api(`/live/api/hello?t=${token}`)).body.mail, true);
  async function upload(email, uploaderId = 'u1') {
    const form = new FormData();
    form.append('t', token); form.append('siteId', site.id); form.append('uploaderId', uploaderId);
    if (email !== undefined) form.append('email', email);
    form.append('photo', new Blob([Buffer.from('test-image')], { type: 'image/jpeg' }), 'photo.jpg');
    const res = await fetch(base + '/live/api/photo', { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  }
  const mailState = async id => (await api(`/live/api/mail?t=${token}&ids=${id}`)).body.photos[0]?.status;

  const rejected = await upload('guest@example');
  assert.equal(rejected.status, 400);
  assert.equal((await api('/api/photos')).body.total, 0, 'a rejected address stores no photo');
  const plain = await upload();
  assert.equal(plain.body.mail, undefined);
  assert.equal(await mailState(plain.body.photo.id), undefined);

  const kept = await upload('guest@example.com'), cancelledPhoto = await upload('guest@example.com'), cancelledMail = await upload('guest@example.com');
  assert.deepEqual([kept.body.mail, kept.body.mailAfterSec], ['queued', 10]);
  assert.equal(await mailState(kept.body.photo.id), 'queued');
  assert.equal((await api(`/live/api/photo/${cancelledMail.body.photo.id}/mail?t=${token}&uploaderId=intruder`, 'DELETE')).status, 410);
  assert.equal((await api(`/live/api/photo/${cancelledMail.body.photo.id}/mail?t=${token}&uploaderId=u1`, 'DELETE')).status, 200);
  assert.equal((await fetch(base + cancelledMail.body.photo.url)).status, 200, 'cancelling the mail keeps the photo on screen');
  assert.equal((await api(`/live/api/photo/${cancelledPhoto.body.photo.id}?t=${token}&uploaderId=u1`, 'DELETE')).status, 200);
  assert.equal(await mailState(cancelledPhoto.body.photo.id), 'cancelled');
  assert.equal((await api(`/live/api/mail?t=wrong&ids=${kept.body.photo.id}`)).status, 401);
  assert.equal(smtp.mails.length, 0, 'nothing is sent inside the cancel window');

  const end = Date.now() + 25000;
  while (!smtp.mails.length && Date.now() < end) await sleep(200);
  assert.equal(smtp.mails.length, 1, logs);
  assert.deepEqual(smtp.mails[0].to, ['guest@example.com']);
  assert.equal(attachments(smtp.mails[0].raw), 1, 'only the photo that was neither cancelled nor withdrawn is attached');
  while (await mailState(kept.body.photo.id) !== 'sent' && Date.now() < end) await sleep(100);
  assert.equal(await mailState(kept.body.photo.id), 'sent');
  const status = (await api('/api/live')).body.mail;
  assert.deepEqual([status.configured, status.waiting, status.sentToday, status.error], [true, 0, 1, '']);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'photo-mail', 'jobs')), []);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'photo-mail', 'media')), []);
  assert.equal(logs.includes('guest@example.com'), false, 'the recipient address is never logged');
  assert.equal(JSON.stringify((await api('/api/live')).body).includes('guest@example.com'), false);
});
