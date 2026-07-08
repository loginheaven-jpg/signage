/**
 * 디지털 게시판 클라이언트 플레이어 (Electron)
 * - 구글드라이브 직접 동기화 (로컬 캐시)
 * - 편성표 기반 독립 자동 순환 재생
 * - 호스트 연결 시 편성표 수신 + 푸시로 즉시 반영
 * - 호스트 꺼져도 마지막 편성표 + 캐시로 계속 재생
 */

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');
const ClientGDriveSync = require('./gdrive-sync');
const ScheduleManager = require('./schedule');
const config = require('./config');

const store = new Store();

// ─── 설정 ────────────────────────────────────────────────
const HOST_URL = config.HOST_URL || 'ws://localhost:3000';
const CLIENT_ID = store.get('clientId') || uuidv4();
const CLIENT_NAME = config.CLIENT_NAME || `Player-${CLIENT_ID.slice(0, 6)}`;
const GDRIVE_FOLDER_ID = config.GDRIVE_FOLDER_ID || '1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm';

// 설정 저장 (clientId 영속)
store.set('clientId', CLIENT_ID);

let windows = [];
let ws = null;
let reconnectTimer = null;
let gdrive = null;
let schedule = null;

// ─── 구글 드라이브 동기화 ────────────────────────────────
function initGDrive() {
  gdrive = new ClientGDriveSync({
    credentialsPath: path.join(__dirname, 'credentials', 'service-account.json'),
    folderId: GDRIVE_FOLDER_ID,
    cacheDir: path.join(__dirname, 'cache', 'media'),
    syncInterval: 5 * 60 * 1000 // 5분
  });

  gdrive.on('files-changed', (files) => {
    console.log(`[Main] 드라이브 파일 변경 감지: ${files.length}개`);
    // 편성표가 없으면 전체 파일을 순서대로 자동 편성
    if (schedule.isEmpty()) {
      autoGenerateSchedule(files);
    }
    // 재생 엔진에 파일 목록 업데이트 알림
    notifyPlayEngine();
  });

  return gdrive.initialize().then(ok => {
    if (ok) {
      gdrive.startAutoSync();
    } else {
      console.warn('[Main] 드라이브 초기화 실패 — 기존 캐시로 재생');
    }
  });
}

// ─── 편성표 관리 ─────────────────────────────────────────
function initSchedule() {
  schedule = new ScheduleManager({
    dataDir: path.join(__dirname, 'cache')
  });
  schedule.initialize();

  schedule.on('updated', (entries) => {
    console.log(`[Main] 편성표 업데이트: ${entries.length}개 항목`);
    notifyPlayEngine();
  });
}

/**
 * 편성표가 비어있을 때 드라이브 파일로 자동 편성 생성
 */
function autoGenerateSchedule(files) {
  if (!files || files.length === 0) return;

  const monitorCount = windows.length || 1;
  const entries = [];

  if (monitorCount >= 2) {
    // 듀얼 모니터: 2개씩 쌍으로 묶기
    for (let i = 0; i < files.length; i += 2) {
      entries.push({
        id: uuidv4(),
        order: entries.length + 1,
        file1: files[i].name,
        file2: (i + 1 < files.length) ? files[i + 1].name : null,
        duration: 10,
        videoDuration: 'original',
        transition: 'fade',
        enabled: true
      });
    }
  } else {
    // 단일 모니터: 1개씩
    files.forEach((f, idx) => {
      entries.push({
        id: uuidv4(),
        order: idx + 1,
        file1: f.name,
        file2: null,
        duration: 10,
        videoDuration: 'original',
        transition: 'fade',
        enabled: true
      });
    });
  }

  schedule.entries = entries;
  schedule.version = Date.now();
  schedule.save();
  console.log(`[Main] 자동 편성표 생성: ${entries.length}개 항목`);
}

// ─── 재생 엔진 알림 ─────────────────────────────────────
function notifyPlayEngine() {
  const activeEntries = schedule.getActiveEntries();
  const cachedFiles = gdrive ? gdrive.getFileList() : [];

  // 편성표의 파일명을 로컬 경로로 매핑
  const playlist = activeEntries.map(entry => {
    const f1 = cachedFiles.find(f => f.name === entry.file1);
    const f2 = entry.file2 ? cachedFiles.find(f => f.name === entry.file2) : null;
    return {
      ...entry,
      file1Path: f1 ? f1.localPath : null,
      file1Mime: f1 ? f1.mimeType : null,
      file2Path: f2 ? f2.localPath : null,
      file2Mime: f2 ? f2.mimeType : null
    };
  }).filter(e => e.file1Path); // 로컬에 파일이 있는 항목만

  // 모든 윈도우에 편성표 전달
  windows.forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-playlist', {
        playlist,
        monitorCount: windows.length
      });
    }
  });
}

// ─── 윈도우 생성 ─────────────────────────────────────────
function createPlayerWindows() {
  const displays = screen.getAllDisplays();
  const monitorCount = Math.min(displays.length, 2);

  console.log(`[Player] 감지된 모니터: ${displays.length}대, 사용: ${monitorCount}대`);

  for (let i = 0; i < monitorCount; i++) {
    const display = displays[i];
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    win.loadFile('player.html');
    win.setFullScreen(true);
    win.monitorIndex = i; // 모니터 인덱스 저장
    windows.push(win);
  }

  return monitorCount;
}

// ─── WebSocket 연결 (호스트) ─────────────────────────────
function connectToHost() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log(`[WS] 호스트 연결 시도: ${HOST_URL}`);

  try {
    ws = new WebSocket(HOST_URL);
  } catch (e) {
    console.error('[WS] 연결 생성 실패:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[WS] 호스트 연결 성공');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }

    // 핸드셰이크: 등록 메시지 전송
    ws.send(JSON.stringify({
      type: 'register',
      clientId: CLIENT_ID,
      name: CLIENT_NAME,
      monitors: windows.length,
      scheduleVersion: schedule ? schedule.getVersion() : 0
    }));

    // 하트비트 시작
    startHeartbeat();

    // 연결 상태를 플레이어에 알림
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('host-status', { connected: true });
      }
    });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleHostMessage(msg);
    } catch (e) {
      console.error('[WS] 메시지 파싱 오류:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 호스트 연결 끊김');
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('host-status', { connected: false });
      }
    });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[WS] 오류:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectToHost();
    }
  }, 5000);
}

let heartbeatInterval = null;
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        clientId: CLIENT_ID,
        scheduleVersion: schedule ? schedule.getVersion() : 0
      }));
    }
  }, 10000);
}

// ─── 호스트 메시지 처리 ──────────────────────────────────
function handleHostMessage(msg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[Host] 등록 확인: ${msg.message}`);
      break;

    case 'schedule_update':
      // 호스트에서 편성표 푸시
      console.log('[Host] 편성표 수신');
      if (schedule.applyFromHost(msg.schedule)) {
        notifyPlayEngine();
      }
      break;

    case 'sync_now':
      // 호스트에서 즉시 동기화 명령
      console.log('[Host] 즉시 동기화 명령 수신');
      if (gdrive) {
        gdrive.sync();
      }
      break;

    case 'play':
      // 호스트에서 직접 재생 명령 (수동 제어)
      console.log(`[Host] 직접 재생 명령: ${msg.files.length}개 파일`);
      handleDirectPlay(msg.files);
      break;

    case 'stop':
      console.log('[Host] 정지 명령');
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('stop');
        }
      });
      break;
  }
}

/**
 * 호스트에서 직접 재생 명령 처리 (수동 제어 모드)
 */
function handleDirectPlay(files) {
  const hostHttp = HOST_URL.replace('ws://', 'http://').replace('wss://', 'https://');

  if (windows.length === 1) {
    windows[0].webContents.send('play', {
      files: files.map(f => ({
        url: `${hostHttp}${f.url}`,
        mimeType: f.mimeType,
        originalName: f.originalName
      })),
      mode: 'sequential'
    });
  } else if (windows.length >= 2) {
    files.forEach((f, idx) => {
      if (idx < windows.length && !windows[idx].isDestroyed()) {
        windows[idx].webContents.send('play', {
          files: [{
            url: `${hostHttp}${f.url}`,
            mimeType: f.mimeType,
            originalName: f.originalName
          }],
          mode: 'single'
        });
      }
    });
  }
}

// ─── 앱 라이프사이클 ─────────────────────────────────────
app.whenReady().then(async () => {
  // 1. 윈도우 생성
  createPlayerWindows();

  // 2. 편성표 로드
  initSchedule();

  // 3. 드라이브 동기화 시작
  await initGDrive();

  // 4. 호스트 연결 (비동기, 실패해도 독립 재생)
  connectToHost();

  // 5. 초기 재생 시작 (캐시된 파일 + 저장된 편성표)
  setTimeout(() => {
    notifyPlayEngine();
  }, 3000); // 드라이브 첫 동기화 대기
});

app.on('window-all-closed', () => {
  if (gdrive) gdrive.stopAutoSync();
  app.quit();
});

// ESC 키로 종료 (개발/디버그용)
app.on('browser-window-created', (_, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      if (gdrive) gdrive.stopAutoSync();
      app.quit();
    }
  });
});
