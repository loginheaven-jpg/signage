// Real Chromium rendering/codec test for our local pages. No production connection,
// no user clipboard mutation, and no visible desktop window.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-photo-smoke-'));
const depsRoot = path.join(project, 'client/.signage/dependencies');
const dependency = fs.readdirSync(depsRoot).find(name => fs.existsSync(path.join(depsRoot, name, 'node_modules/electron/dist/electron.exe')));
if (!dependency) throw new Error('Install the client dependencies before running this optional Chromium test.');
const executable = path.join(depsRoot, dependency, 'node_modules/electron/dist/electron.exe');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'signage-photo-smoke', version: '1.0.0', main: 'main.cjs' }));
const screenshot = path.join(root, 'photo-library.png');
fs.writeFileSync(path.join(root, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const publicDir = ${JSON.stringify(path.join(project, 'host/public'))};
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
app.disableHardwareAcceleration();
let win, server, jpeg;
const statuses = { folderId: 'test', folderName: '예봄 사진 보관함', ready: true, authMode: 'oauth', oauthConfigured: true, counts: { saved: 1, pending: 0, error: 0, deleting: 0 } };
const rows = [{ id: 'photo', message: '오늘의 예봄 — 함께한 시간을 기억합니다', ts: Date.parse('2026-09-25T09:15:30Z'), siteName: '현관', name: 'photo.jpg', status: 'saved', url: '/api/photos/photo/image' }];
server = http.createServer((req,res) => {
  if (req.url.startsWith('/api/photos/photo/image')) { res.setHeader('Content-Type','image/jpeg'); return res.end(jpeg); }
  if (req.url.startsWith('/api/photos?')) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({photos:rows,total:rows.length,status:statuses})); }
  const name = req.url === '/photos' ? 'photos.html' : req.url.slice(1);
  if (!['photos.html','photos.js','m.html'].includes(name)) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(publicDir,name)));
});
app.whenReady().then(async () => {
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    win = new BrowserWindow({show:false,width:1280,height:960,webPreferences:{backgroundThrottling:false,offscreen:true}});
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/m.html');
    const resized = await win.webContents.executeJavaScript(\`(async () => {
      const canvas=document.createElement('canvas'); canvas.width=6000; canvas.height=4000;
      const ctx=canvas.getContext('2d'); const gradient=ctx.createLinearGradient(0,0,6000,4000);
      gradient.addColorStop(0,'#547d9b'); gradient.addColorStop(1,'#d8b682'); ctx.fillStyle=gradient; ctx.fillRect(0,0,6000,4000);
      ctx.fillStyle='#ffffff'; ctx.font='220px sans-serif'; ctx.fillText('YEBOM · PHOTO ARCHIVE',500,2100);
      const original=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const converted=await resizeImage(original,3840,0.9);
      const decoded=await createImageBitmap(converted);
      const dimensions=[decoded.width,decoded.height,converted.type]; decoded.close();
      canvas.width=640;canvas.height=480;
      const small=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const smallImage=await createImageBitmap(await resizeImage(small,3840,0.9));
      const smallDimensions=[smallImage.width,smallImage.height];smallImage.close();
      const data=await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(converted)});
      return {dimensions,smallDimensions,data};
    })()\`);
    assert.deepEqual(resized.dimensions,[3840,2560,'image/jpeg']); assert.deepEqual(resized.smallDimensions,[640,480]);
    jpeg=Buffer.from(resized.data.split(',')[1],'base64');
    await win.loadURL('http://127.0.0.1:'+server.address().port+'/photos');
    await win.webContents.executeJavaScript(\`load().then(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))))\`);
    const copied = await win.webContents.executeJavaScript(\`(async()=>{
      let clipboardPromise;
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:items=>{
        clipboardPromise=(async()=>{const blob=await items[0].getType('image/png');const im=await createImageBitmap(blob);const result=[im.width,im.height,blob.type];im.close();return result})();return clipboardPromise.then(()=>{});
      }}});
      [...document.querySelectorAll('button')].find(b=>b.textContent==='사진 복사').click();
      const dimensions=await clipboardPromise;
      const result={dimensions,cards:document.querySelectorAll('.card').length,text:document.querySelector('.caption').textContent};
      window.photoXss=0;const hostile=card({id:'hostile',message:'<img src=x onerror="window.photoXss=1">',ts:Date.now(),siteName:'<script>bad</script>',name:'x',status:'pending',url:'/api/photos/photo/image'});document.querySelector('#grid').append(hostile);
      result.safeCaption=hostile.querySelector('.caption').children.length===0 && window.photoXss===0;
      hostile.remove();
      renderStatus({...${JSON.stringify({ ready: false, authMode: 'service-account', oauthConfigured: false, folderId: 'test', counts: { saved: 0, pending: 1, error: 0 } })},error:'계정 연결 필요'});
      result.hiddenConnect=getComputedStyle(document.querySelector('#connect')).display==='none';
      return result;
    })()\`,true);
    assert.deepEqual(copied.dimensions,[3840,2560,'image/png']);assert.equal(copied.cards,1);assert.equal(copied.safeCaption,true);assert.equal(copied.hiddenConnect,true);
    await win.webContents.executeJavaScript('renderStatus('+JSON.stringify(statuses)+')');
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    fs.writeFileSync(${JSON.stringify(screenshot)},(await win.webContents.capturePage()).toPNG());
    console.log('Chromium: 6000→3840 JPEG, no upscaling, full-size PNG clipboard payload, escaped captions, connection state and card rendering passed.');
    console.log('SCREENSHOT='+${JSON.stringify(screenshot)});
    win.destroy();server.close();app.exit(0);
  } catch(e) { console.error(e); if(win)win.destroy();server.close();app.exit(1); }
});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const timeout = setTimeout(() => child.kill(), 45000);
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code || 0; });
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
