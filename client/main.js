/**
 * 디지털 게시판 클라이언트 플레이어 (Electron) — 완전판
 * 
 * 핵심 기능:
 * - 듀얼 모니터: 각 모니터에 독립 키오스크 전체화면 창
 * - 구글드라이브 직접 동기화 (로컬 캐시, 5분 주기 + 호스트 푸시)
 * - 편성표 기반 독립 자동 순환 재생
 * - 호스트 연결 시 편성표 수신 + 푸시로 즉시 반영
 * - 호스트 꺼져도 마지막 편성표 + 캐시로 계속 재생
 * - 부팅 시 자동 시작, 키오스크 모드, 워치독
 */

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');
const ClientGDriveSync = require('./gdrive-sync');
const ScheduleManager = require('./schedule');
const config = require('./config');

// ─── 설정 ────────────────────────────────────────────────
const store = new Store();
const HOST_URL = config.HOST_URL || 'ws://localhost:3000';
const CLIENT_ID = store.get('clientId') || uuidv4();
const CLIENT_NAME = config.CLIENT_NAME || `Player-${CLIENT_ID.slice(0, 6)}`;
const GDRIVE_FOLDER_ID = config.GDRIVE_FOLDER_ID || '';

// 설정 영속 저장
store.set('clientId', CLIENT_ID);

// ─── 전역 상태 ──────────────────────────────────────────
let windows = [];       // 모니터별 BrowserWindow 배열
let ws = null;          // WebSocket 연결
let reconnectTimer = null;
let heartbeatInterval = null;
let gdrive = null;      // 드라이브 동기화 모듈
let schedule = null;    // 편성표 관리 모듈
let isReady = false;    // 윈도우 로드 완료 여부

console.log('═══════════════════════════════════════════════');
console.log('  디지털 게시판 클라이언트 플레이어');
console.log(`  이름: ${CLIENT_NAME}`);
console.log(`  ID: ${CLIENT_ID}`);
console.log(`  호스트: ${HOST_URL}`);
console.log(`  드라이브 폴더: ${GDRIVE_FOLDER_ID || '(미설정)'}`);
console.log('═══════════════════════════════════════════════');

// ─── 윈도우 생성 (핵심: 각 모니터에 키오스크 전체화면) ────

function createPlayerWindows() {
  const displays = screen.getAllDisplays();
  const monitorCount = Math.min(displays.length, 2); // 최대 2대

  console.log(`[Display] 감지된 모니터: ${displays.length}대, 사용: ${monitorCount}대`);
  displays.forEach((d, i) => {
    console.log(`  모니터 ${i}: ${d.bounds.width}x${d.bounds.height} @ (${d.bounds.x}, ${d.bounds.y}) ${d.internal ? '(내장)' : '(외장)'}`);
  });

  for (let i = 0; i < monitorCount; i++) {
    const display = displays[i];
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      kiosk: true,
      frame: false,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      backgroundColor: '#000000',
      show: false, // 준비 완료 후 표시
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    win.loadFile('player.html');

    // 준비 완료 후 표시 + 키오스크 진입
    win.once('ready-to-show', () => {
      win.show();
      win.setFullScreen(true);
      win.setKiosk(true);
      console.log(`[Display] 모니터 ${i} 키오스크 활성화`);
    });

    // 로드 완료 후 초기화 정보 전달
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('init', {
        monitorIndex: i,
        monitorCount: monitorCount,
        clientName: CLIENT_NAME
      });
      console.log(`[Display] 모니터 ${i}에 init 전송 (${monitorCount}대 모드)`);
    });

    // 크래시 복구
    win.webContents.on('crashed', () => {
      console.error(`[Display] 모니터 ${i} 렌더러 크래시! 재로드...`);
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.reload();
        }
      }, 2000);
    });

    windows.push(win);
    console.log(`[Display] 모니터 ${i} 창 생성: ${display.bounds.width}x${display.bounds.height}`);
  }

  return monitorCount;
}

// ─── 구글 드라이브 동기화 ────────────────────────────────

function initGDrive() {
  if (!GDRIVE_FOLDER_ID) {
    console.warn('[GDrive] 폴더 ID 미설정 — 드라이브 동기화 비활성');
    return Promise.resolve();
  }

  const credPath = path.join(__dirname, 'credentials', 'service-account.json');
  if (!fs.existsSync(credPath)) {
    console.warn('[GDrive] 서비스 계정 키 없음 — 드라이브 동기화 비활성');
    return Promise.resolve();
  }

  gdrive = new ClientGDriveSync({
    credentialsPath: credPath,
    folderId: GDRIVE_FOLDER_ID,
    cacheDir: path.join(__dirname, 'cache', 'media'),
    syncInterval: 5 * 60 * 1000 // 5분
  });

  gdrive.on('files-changed', (files) => {
    console.log(`[GDrive] 파일 변경 감지: ${files.length}개`);
    // 편성표가 비어있으면 자동 편성 생성
    if (schedule && schedule.isEmpty()) {
      autoGenerateSchedule(files);
    }
    notifyPlayEngine();
  });

  return gdrive.initialize().then(ok => {
    if (ok) {
      gdrive.startAutoSync();
      console.log('[GDrive] 자동 동기화 시작 (5분 간격)');
    } else {
      console.warn('[GDrive] 초기화 실패 — 기존 캐시로 재생');
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
    console.log(`[Schedule] 편성표 업데이트됨: ${entries.length}개 항목`);
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
    // 듀얼 모니터: 파일을 2개씩 묶어서 좌/우 배분
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
    // 싱글 모니터: 파일 하나씩 순차
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
  console.log(`[Schedule] 자동 편성표 생성: ${entries.length}개 항목 (${monitorCount}대 모드)`);
}

// ─── 재생 엔진 알림 (편성표 → 윈도우 전달) ──────────────

function notifyPlayEngine() {
  if (!isReady) return;

  const activeEntries = schedule ? schedule.getActiveEntries() : [];
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
  }).filter(e => e.file1Path); // 파일이 캐시에 없는 항목은 제외

  console.log(`[Engine] 재생목록 전달: ${playlist.length}개 항목 → ${windows.length}개 윈도우`);

  // 각 윈도우에 편성표 전달
  windows.forEach((win, idx) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-playlist', {
        playlist,
        monitorIndex: idx,
        monitorCount: windows.length
      });
    }
  });
}

// ─── WebSocket 연결 (호스트) ─────────────────────────────

function connectToHost() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log(`[WS] 호스트 연결 시도: ${HOST_URL}`);

  try {
    ws = new WebSocket(HOST_URL, {
      rejectUnauthorized: false
    });
  } catch (e) {
    console.error('[WS] 연결 생성 실패:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[WS] ✓ 호스트 연결 성공');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }

    // 등록 메시지 전송
    ws.send(JSON.stringify({
      type: 'register',
      clientId: CLIENT_ID,
      name: CLIENT_NAME,
      monitors: windows.length,
      scheduleVersion: schedule ? schedule.getVersion() : 0
    }));

    startHeartbeat();
    broadcastHostStatus(true);
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
    broadcastHostStatus(false);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    // 연결 실패는 조용히 처리 (재연결이 자동으로 됨)
    if (err.code !== 'ECONNREFUSED') {
      console.error('[WS] 오류:', err.message);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectToHost();
    }
  }, 5000); // 5초마다 재연결 시도
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        clientId: CLIENT_ID,
        monitors: windows.length,
        scheduleVersion: schedule ? schedule.getVersion() : 0,
        isPlaying: true
      }));
    }
  }, 10000);
}

function broadcastHostStatus(connected) {
  windows.forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('host-status', { connected });
    }
  });
}

// ─── 호스트 메시지 처리 ──────────────────────────────────

function handleHostMessage(msg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[Host] 등록 확인: ${msg.message || 'OK'}`);
      break;

    case 'schedule_update':
      console.log('[Host] 편성표 수신');
      if (schedule && schedule.applyFromHost(msg.schedule)) {
        notifyPlayEngine();
      }
      break;

    case 'sync_now':
      console.log('[Host] 즉시 동기화 명령');
      if (gdrive) {
        gdrive.sync().then(() => {
          notifyPlayEngine();
        });
      }
      break;

    case 'play':
      console.log(`[Host] 직접 재생 명령: ${msg.files?.length || 0}개 파일`);
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

    default:
      console.log(`[Host] 알 수 없는 메시지: ${msg.type}`);
  }
}

/**
 * 호스트에서 직접 재생 명령 처리 (수동 제어 모드)
 */
function handleDirectPlay(files) {
  if (!files || files.length === 0) return;

  const hostHttp = HOST_URL.replace('ws://', 'http://').replace('wss://', 'https://');

  if (windows.length >= 2 && files.length >= 2) {
    // 듀얼: 파일1 → 모니터0, 파일2 → 모니터1
    for (let i = 0; i < Math.min(files.length, windows.length); i++) {
      if (!windows[i].isDestroyed()) {
        windows[i].webContents.send('play', {
          files: [{
            url: `${hostHttp}${files[i].url}`,
            mimeType: files[i].mimeType,
            originalName: files[i].originalName
          }],
          mode: 'single'
        });
      }
    }
  } else {
    // 싱글: 첫 번째 윈도우에서 재생
    if (windows[0] && !windows[0].isDestroyed()) {
      windows[0].webContents.send('play', {
        files: files.map(f => ({
          url: `${hostHttp}${f.url}`,
          mimeType: f.mimeType,
          originalName: f.originalName
        })),
        mode: 'sequential'
      });
    }
  }
}

// ─── 앱 라이프사이클 ─────────────────────────────────────

app.whenReady().then(async () => {
  console.log('[App] 시작...');

  // 1. 윈도우 생성 (각 모니터에 키오스크 전체화면)
  const monitorCount = createPlayerWindows();

  // 2. 편성표 로드
  initSchedule();

  // 3. 드라이브 동기화 시작
  await initGDrive();

  // 4. 호스트 연결 (비동기, 실패해도 독립 재생)
  connectToHost();

  // 5. 윈도우 로드 대기 후 재생 시작
  setTimeout(() => {
    isReady = true;
    notifyPlayEngine();
    console.log('[App] ✓ 초기화 완료 — 재생 시작');
  }, 3000);
});

// 모든 창이 닫히면 종료
app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

// 정리 함수
function cleanup() {
  if (gdrive) gdrive.stopAutoSync();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (reconnectTimer) clearInterval(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch (e) {}
  }
}

// ─── 키보드 단축키 (관리용) ─────────────────────────────
app.on('browser-window-created', (_, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    // ESC: 종료 (관리자용)
    if (input.key === 'Escape' && input.control) {
      console.log('[App] Ctrl+ESC — 종료');
      cleanup();
      app.quit();
    }
    // F5: 강제 동기화
    if (input.key === 'F5') {
      console.log('[App] F5 — 강제 동기화');
      if (gdrive) gdrive.sync();
    }
    // F11: 전체화면 토글 (디버그용)
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });
});

// ─── 미처리 예외 방지 (크래시 방지) ─────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 미처리 예외:', err.message);
  console.error(err.stack);
  // 크래시하지 않고 계속 실행
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 미처리 Promise 거부:', reason);
});
