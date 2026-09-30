const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('../host/node_modules/ws');

test('production camera login protects legacy URLs, accepts uploads, and closing intake preserves photos', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-camera-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {cwd:path.join(__dirname,'../host'),windowsHide:true,
    env:{...process.env,PORT:String(port),NODE_ENV:'production',ADMIN_PASSWORD:'test-admin',CAMERA_PASSWORD:'test-camera',DATA_DIR:dir,UPLOADS_DIR:path.join(dir,'uploads'),GOOGLE_SERVICE_ACCOUNT_KEY:'',GDRIVE_FOLDER_ID:'test'},stdio:'ignore'});
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir,{recursive:true,force:true});
  });
  for(let i=0;i<100;i++) { try { await fetch(base+'/privacy'); break; } catch { await new Promise(resolve=>setTimeout(resolve,100)); } }
  const request = (route, cookie, body, method) => fetch(base+route,{method:method||(body?'POST':'GET'),redirect:'manual',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
  for(const route of ['/','/index.html','/photos','/photos.html','/m','/m.html','/camera']) assert.equal((await request(route)).status,302,route);
  for(const route of ['/privacy','/terms','/camera.webmanifest','/camera-sw.js','/camera-icon-192.png','/camera-icon-512.png','/player']) assert.equal((await request(route)).status,200,route);
  assert.equal((await request('/api/sites')).status,401);
  const login = async(role,password) => (await request('/auth/login',null,{role,password})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin','test-admin'), camera = await login('camera','test-camera');
  assert.equal((await request('/api/sites',camera)).status,401);
  assert.equal((await request('/camera',camera)).status,200);
  assert.equal((await request('/live/api/hello',admin)).status,401);
  const config = await (await request('/api/live',admin)).json();
  assert.equal((await request('/live/api/hello?t='+config.token)).status,401);
  assert.equal((await fetch(base+'/live/api/photo',{method:'POST',body:new FormData()})).status,401);
  const {site} = await (await request('/api/sites',admin,{name:'test'})).json();
  await request('/api/live',admin,{enabled:true},'PUT');
  const upload = async () => {
    const data = new FormData(); data.set('photo',new Blob(['test-image'],{type:'image/jpeg'}),'test.jpg'); data.set('siteId',site.id); data.set('uploaderId','test'); data.set('uploaderName','test');
    return fetch(base+'/live/api/photo',{method:'POST',headers:{cookie:camera},body:data});
  };
  const uploaded = await upload(); assert.equal(uploaded.status,200);
  const photo = (await uploaded.json()).photo;
  await request('/api/live',admin,{enabled:false},'PUT');
  assert.equal((await upload()).status,403);
  assert.equal((await fetch(base+photo.url)).status,200,'closing intake preserves the screen photo');
  assert.equal((await request(`/api/photos/${photo.id}/image`,admin)).status,200,'archive remains');
  const deniedWs = new WebSocket(base.replace('http','ws'));
  await new Promise(resolve=>deniedWs.once('open',resolve));
  const closed = new Promise(resolve=>deniedWs.once('close',resolve)); deniedWs.send(JSON.stringify({type:'admin_subscribe'}));
  assert.equal(await closed,1008);
  await request('/auth/revoke',admin,{role:'camera'});
  assert.equal((await request('/live/api/hello',camera)).status,401);
});
