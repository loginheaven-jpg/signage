/**
 * 디지털 게시판 클라이언트 (v2 — 설정 UI + 승인 대기 + 플레이어)
 * 
 * 흐름:
 * 1. 최초 실행 → 설정 화면 (이름, 서버 주소, 모니터 수)
 * 2. 호스트 연결 → 대기 상태 (호스트에서 승인 전)
 * 3. 승인 완료 → 전체화면 플레이어 시작
 * 
 * Ctrl+Shift+S → 설정 화면 재표시
 */

const { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

// ─── 설정 파일 관리 ─────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  clientName: '',
  hostUrl: 'https://signage.yebom.org',
  monitors: 1,
  clientId: '',
  approved: false,
  siteId: ''
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...data };
    }
  } catch (e) {
    console.error('[Config] 로드 실패:', e.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Config] 저장 실패:', e.message);
  }
}

loadConfig();

// ─── 로컬 캐시 관리 (오프라인/독립 재생) ─────────────────
// 편성표와 미디어 파일을 로컬에 저장하여, 호스트가 꺼져 있거나
// 인터넷이 끊겨도 마지막으로 받은 편성표로 계속 재생한다.
const CACHE_DIR = path.join(__dirname, 'cache');
const MEDIA_DIR = path.join(CACHE_DIR, 'media');
const SCHEDULE_CACHE = path.join(CACHE_DIR, 'schedule.json');

[CACHE_DIR, MEDIA_DIR].forEach(dir => {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
});

// 마지막으로 수신한 원본 편성표(상대 URL 유지). null이면 아직 편성표 없음.
let currentRawSchedule = null;
let downloading = false;

function loadScheduleCache() {
  try {
    if (fs.existsSync(SCHEDULE_CACHE)) {
      currentRawSchedule = JSON.parse(fs.readFileSync(SCHEDULE_CACHE, 'utf8'));
      console.log(`[Cache] 편성표 캐시 로드: v${currentRawSchedule?.version}, ${currentRawSchedule?.entries?.length || 0}개`);
    }
  } catch (e) {
    console.warn('[Cache] 편성표 캐시 로드 실패:', e.message);
    currentRawSchedule = null;
  }
}

function saveScheduleCache() {
  try {
    fs.writeFileSync(SCHEDULE_CACHE, JSON.stringify(currentRawSchedule, null, 2));
  } catch (e) {
    console.error('[Cache] 편성표 캐시 저장 실패:', e.message);
  }
}

// 편성표 항목의 상대/원격 URL 목록(url, url2)을 추출
function entryRelUrls(entry) {
  const rels = [];
  const r1 = entry.url || (entry.filename ? `/uploads/${entry.filename}` : '');
  if (r1) rels.push({ key: 'url', rel: r1 });
  if (entry.url2) rels.push({ key: 'url2', rel: entry.url2 });
  return rels;
}

function remoteUrlFor(rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  const base = (config.hostUrl || '').replace(/\/+$/, '');
  const path = rel.startsWith('/') ? rel : `/${rel}`;
  // 파일명에 공백/한글이 있어도 안전하도록 경로를 인코딩 (이미 인코딩된 경우 이중 인코딩 방지)
  return base + encodeURI(decodeURI(path));
}

function localFileFor(rel) {
  let name = rel.split('?')[0].split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch (e) {}
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); // 파일명 안전화
  return path.join(MEDIA_DIR, name);
}

function isCached(rel) {
  try {
    const p = localFileFor(rel);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch (e) { return false; }
}

// 원본 편성표를 렌더러가 재생할 수 있는 형태로 변환.
// 캐시된 파일은 file:// 로컬 경로, 없으면 호스트 원격 URL(온라인 시 스트리밍).
function resolveSchedule(raw) {
  if (!raw) return { version: 0, entries: [] };
  const entries = (raw.entries || []).map(e => {
    const resolved = { ...e };
    for (const { key, rel } of entryRelUrls(e)) {
      resolved[key] = isCached(rel)
        ? pathToFileURL(localFileFor(rel)).href
        : remoteUrlFor(rel);
      // 호스트 대시보드 썸네일용 원본(상대) 경로 보존
      resolved[key === 'url' ? 'srcUrl' : 'srcUrl2'] = rel;
    }
    return resolved;
  });
  return { version: raw.version, entries };
}

function sendScheduleToRenderer() {
  if (!currentRawSchedule) return;
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('schedule-update', resolveSchedule(currentRawSchedule));
  }
}

// HTTP(S) GET → 파일 스트림 저장 (리다이렉트 최대 3회 추종)
function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return downloadTo(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = dest + '.part';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try { fs.renameSync(tmp, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      file.on('error', (err) => { try { fs.unlinkSync(tmp); } catch (e) {} reject(err); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

// 편성표에 필요한 미디어 중 캐시에 없는 것을 백그라운드 다운로드.
// 다운로드가 끝날 때마다 렌더러에 갱신 편성표를 재전송하여 로컬 재생으로 전환.
async function downloadMissing(raw) {
  if (!raw || downloading) return;
  downloading = true;
  const keep = new Set();
  try {
    for (const e of (raw.entries || [])) {
      for (const { rel } of entryRelUrls(e)) {
        const dest = localFileFor(rel);
        keep.add(path.basename(dest));
        if (isCached(rel)) continue;
        try {
          await downloadTo(remoteUrlFor(rel), dest);
          console.log(`[Cache] ✓ 미디어 캐시: ${path.basename(dest)}`);
          sendScheduleToRenderer(); // 받는 즉시 로컬 파일로 전환
        } catch (err) {
          console.warn(`[Cache] 미디어 다운로드 실패 (${rel}):`, err.message);
        }
      }
    }
    // 현재 편성표에 없는 캐시 파일 정리
    try {
      for (const f of fs.readdirSync(MEDIA_DIR)) {
        if (!keep.has(f) && !f.endsWith('.part')) {
          fs.unlinkSync(path.join(MEDIA_DIR, f));
          console.log(`[Cache] ✗ 미사용 미디어 삭제: ${f}`);
        }
      }
    } catch (e) {}
  } finally {
    downloading = false;
  }
}

loadScheduleCache();

// ─── 윈도우 관리 ────────────────────────────────────────
let mainWindow = null;
let secondWindow = null;   // 듀얼 모니터: 보조(우측) 화면
let dualMonitor = false;   // 보조 창 활성 여부 (렌더러에 전달)
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;

// ─── 듀얼 모니터 보조 창 관리 ────────────────────────────
// config.monitors >= 2 이고 물리 디스플레이가 2개 이상일 때만 보조 창 생성.
// 그 외에는 주 창에서 분할(좌/우)을 나란히 렌더링한다.
function ensureSecondWindow() {
  const displays = screen.getAllDisplays();
  const wantDual = config.monitors >= 2 && config.approved && displays.length >= 2;

  if (!wantDual) {
    dualMonitor = false;
    if (secondWindow && !secondWindow.isDestroyed()) { secondWindow.close(); }
    secondWindow = null;
    return;
  }

  if (secondWindow && !secondWindow.isDestroyed()) { dualMonitor = true; return; }

  const primary = screen.getPrimaryDisplay();
  const ext = displays.find(d => d.id !== primary.id) || displays[1];
  secondWindow = new BrowserWindow({
    x: ext.bounds.x, y: ext.bounds.y,
    width: ext.bounds.width, height: ext.bounds.height,
    fullscreen: true, frame: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  secondWindow.loadFile('player.html', { query: { screen: '2' } });
  secondWindow.on('closed', () => { secondWindow = null; dualMonitor = false; });
  dualMonitor = true;
}

function closeSecondWindow() {
  dualMonitor = false;
  if (secondWindow && !secondWindow.isDestroyed()) secondWindow.close();
  secondWindow = null;
}

// ─── 재생 제어 (일시정지 / 종료 / 설정) ───────────────────
function sendToBoth(channel, payload) {
  [mainWindow, secondWindow].forEach(w => {
    if (w && !w.isDestroyed() && w.webContents) w.webContents.send(channel, payload);
  });
}

function togglePause() {
  // 실제 상태는 렌더러가 보유(토글 방식). 두 창 모두에 전달.
  sendToBoth('toggle-pause');
}

function openSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(false);
    mainWindow.loadFile('setup.html');
  }
}

function confirmQuit() {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const res = dialog.showMessageBoxSync(parent, {
    type: 'question',
    buttons: ['취소', '종료'],
    defaultId: 0,
    cancelId: 0,
    title: '종료 확인',
    message: '디지털 게시판 플레이어를 종료할까요?',
    detail: '종료하면 이 화면의 재생이 멈춥니다. (부팅 시 자동으로 다시 실행됩니다)'
  });
  if (res === 1) app.quit();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: config.approved,
    frame: !config.approved,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 페이지 로드가 끝나면 캐시된 편성표를 전달 (플레이어면 즉시 재생 시작)
  mainWindow.webContents.on('did-finish-load', () => {
    sendScheduleToRenderer();
  });

  // 설정이 없으면 설정 화면, 있으면 플레이어 화면
  if (!config.clientName || !config.hostUrl) {
    mainWindow.loadFile('setup.html');
  } else if (!config.approved) {
    mainWindow.loadFile('waiting.html');
    connectToHost();
  } else {
    mainWindow.loadFile('player.html');
    ensureSecondWindow();
    connectToHost();
  }

  // Ctrl+Shift+S → 설정 화면
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    mainWindow.setFullScreen(false);
    mainWindow.loadFile('setup.html');
  });

  // Ctrl+Shift+F → 전체화면 토글
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // ESC → 전체화면 해제
  globalShortcut.register('Escape', () => {
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });

  // Ctrl+Shift+P → 일시정지/재개 토글
  globalShortcut.register('CommandOrControl+Shift+P', () => togglePause());

  // Ctrl+Shift+Q → 종료 (확인창)
  globalShortcut.register('CommandOrControl+Shift+Q', () => confirmQuit());
}

// ─── IPC 핸들러 ─────────────────────────────────────────

// 설정 저장 및 연결 시작
ipcMain.handle('save-config', async (event, newConfig) => {
  config.clientName = newConfig.clientName;
  config.hostUrl = newConfig.hostUrl;
  config.monitors = newConfig.monitors || 1;
  if (!config.clientId) {
    config.clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  config.approved = false;
  saveConfig();

  // 대기 화면으로 전환
  mainWindow.loadFile('waiting.html');
  connectToHost();

  return { success: true, clientId: config.clientId };
});

// 현재 설정 조회 (런타임 듀얼 모니터 상태 포함)
ipcMain.handle('get-config', async () => {
  return { ...config, dualMonitor };
});

// 듀얼 모니터: 주 창 → 보조 창으로 우측 미디어 전달
ipcMain.on('screen2-media', (event, media) => {
  if (secondWindow && !secondWindow.isDestroyed() && secondWindow.webContents) {
    secondWindow.webContents.send('screen2-media', media);
  }
});

// 플레이어가 현재 재생 중인 콘텐츠를 보고 → 대시보드 표시용으로 호스트에 즉시 전달
ipcMain.on('report-playing', (event, playing) => {
  lastPlaying = playing;
  sendHeartbeat();
});

// 화면 하단 컨트롤 바에서 오는 명령
ipcMain.on('ui-toggle-pause', () => togglePause());
ipcMain.on('ui-open-settings', () => openSettings());
ipcMain.on('ui-quit', () => confirmQuit());

// 현재 상태 조회
ipcMain.handle('get-status', async () => {
  return {
    connected: ws && ws.readyState === WebSocket.OPEN,
    approved: config.approved,
    clientName: config.clientName,
    siteId: config.siteId
  };
});

// ─── WebSocket 연결 ─────────────────────────────────────

function connectToHost() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  const wsUrl = config.hostUrl.replace(/^http/, 'ws');
  console.log(`[WS] 연결 시도: ${wsUrl}`);

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('[WS] 연결 생성 실패:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[WS] 연결 성공');
    
    // 등록 메시지 전송
    ws.send(JSON.stringify({
      type: 'register',
      clientId: config.clientId,
      name: config.clientName,
      monitors: config.monitors,
      scheduleVersion: 0
    }));

    // 하트비트 시작
    startHeartbeat();

    // UI에 연결 상태 전달
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('connection-status', { connected: true });
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (e) {
      console.error('[WS] 메시지 파싱 오류:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 연결 끊김');
    stopHeartbeat();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('connection-status', { connected: false });
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[WS] 오류:', err.message);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[WS] 등록 완료: ${msg.clientId}`);
      config.clientId = msg.clientId;
      saveConfig();
      break;

    case 'approved':
      // 호스트에서 승인됨
      console.log(`[WS] 승인됨! 사이트: ${msg.siteId}`);
      config.approved = true;
      config.siteId = msg.siteId || '';
      saveConfig();
      
      // 플레이어 화면으로 전환
      mainWindow.loadFile('player.html');
      setTimeout(() => {
        mainWindow.setFullScreen(true);
        ensureSecondWindow();
      }, 1000);
      break;

    case 'rejected':
      // 호스트에서 거부됨
      console.log('[WS] 거부됨');
      config.approved = false;
      config.siteId = '';
      saveConfig();
      closeSecondWindow();
      mainWindow.loadFile('waiting.html');
      break;

    case 'schedule_update':
      // 편성표 수신 → 로컬 캐시에 저장하고 렌더러에 즉시 반영
      console.log(`[WS] 편성표 수신: v${msg.schedule?.version}, ${msg.schedule?.entries?.length || 0}개`);
      if (msg.schedule) {
        currentRawSchedule = msg.schedule;
        saveScheduleCache();
        sendScheduleToRenderer();       // 캐시된 파일은 즉시 로컬 재생, 나머지는 원격
        downloadMissing(currentRawSchedule); // 백그라운드로 미디어 로컬 캐시
      }
      break;

    case 'play':
      // 재생 명령
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('play-command', msg.files);
      }
      break;

    case 'stop':
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('stop-command');
      }
      break;

    case 'sync_now':
      console.log('[WS] 동기화 명령 수신');
      break;

    case 'quit':
      // 호스트에서 원격 종료 명령
      console.log('[WS] 호스트 원격 종료 명령 수신 — 앱 종료');
      app.quit();
      break;
  }
}

let lastPlaying = null; // 현재 재생 중 콘텐츠 (대시보드 보고용)

function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'heartbeat',
      clientId: config.clientId,
      scheduleVersion: currentRawSchedule ? (currentRawSchedule.version || 0) : 0,
      currentPlaying: lastPlaying
    }));
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (config.clientName && config.hostUrl) {
      connectToHost();
    }
  }, 5000);
}

// ─── 앱 라이프사이클 ────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (ws) ws.close();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopHeartbeat();
});
