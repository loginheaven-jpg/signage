// Local-only preview backed by an in-memory Drive. Never contacts Google or SMTP.
const express = require('../host/node_modules/express');
const sharp = require('../host/node_modules/sharp');
const path = require('node:path');
const fs = require('node:fs');
const { fixture } = require('../tests/helpers/camera-fixture');
const { mountCameraService } = require('../host/camera-service');
const { mountPhotoRoutes } = require('../host/photo-routes');
const { PhotoMail } = require('../host/photo-mail');
async function startPreview({ email = false } = {}) {
  const cleanup = [];
  const f = fixture({ after: fn => cleanup.push(fn) });
  f.folder('year-2026', '2026', 'root'); f.folder('event-2026', '20260820목자컨퍼런스', 'year-2026');
  f.folder('event-newest', '20261001 가을예배', 'year-2026');
  f.folder('event-old', '20260101 신년예배', 'year-2026');
  f.folder('event-name-b', '찬양예배', 'year-2026'); f.folder('event-name-a', '가족예배', 'year-2026');
  const config = { enabled: true, archiveEnabled: true, settings: { cancelSec: 60, photoTtlMin: 180 } };
  const published = [];
  const sent = [], clock = { now: Date.now() };
  const mail = email ? new PhotoMail({ dataDir: f.root, env: {}, now: () => clock.now, transport: { sendMail: async message => { sent.push(message); } } }) : null;
  const app = express(); app.use(express.json());
  app.get(['/camera', '/m'], (req, res) => res.sendFile(path.resolve(__dirname, '../host/public/m.html')));
  app.get('/photos', (req, res) => res.sendFile(path.resolve(__dirname, '../host/public/photos.html')));
  app.get('/camera-exif.js', (req, res) => res.sendFile(path.resolve(__dirname, '../host/node_modules/exifr/dist/full.umd.js')));
  mountCameraService(app, { archive: f.archive, auth: { check: () => true, sameOrigin: req => !req.get('origin') || new URL(req.get('origin')).host === req.get('host') },
    getConfig: () => config, getSites: () => [{ id: 'offline', name: '1F 로비', online: false }, { id: 'screen', name: '본당 로비', online: true }],
    publish: (photo, bytes) => { published.push({ photo, bytes }); return 1; },
    delivery: id => published.some(p => p.photo.id === id) ? [{ name: '본당 로비', online: true, status: 'displayed' }] : [],
    cancel: id => { const i = published.findIndex(p => p.photo.id === id); if (i >= 0) published.splice(i, 1); }, mail });
  mountPhotoRoutes(app, f.archive, () => {});
  app.use(express.static(path.resolve(__dirname, '../host/public')));
  await f.archive.initialize();
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const photo = path.join(f.root, 'camera-test.png');
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#53786a' } }).png().toFile(photo);
  return { ...f, server, config, published, photo, mail, sent, clock, url: 'http://127.0.0.1:' + server.address().port,
    async close() { await new Promise(r => server.close(r)); cleanup.forEach(fn => fn()); } };
}
module.exports = { startPreview };
if (require.main === module) startPreview().then(p => {
  console.log(JSON.stringify({ url: p.url, photo: p.photo, root: p.root }));
  process.on('SIGINT', () => p.close().then(() => process.exit()));
}).catch(error => { console.error(error); process.exitCode = 1; });
