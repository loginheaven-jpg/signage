/**
 * 디지털 게시판 클라이언트 플레이어 (Electron)
 * - 호스트 서버에 WebSocket으로 연결·핸드셰이크
 * - 재생 명령 수신 시 전체화면으로 콘텐츠 표시
 * - 모니터 개수 자동 감지 (1대 또는 2대)
 */

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');

const store = new Store();

// ─── 설정 ────────────────────────────────────────────────
const HOST_URL = store.get('hostUrl') || process.env.HOST_URL || 'ws://localhost:3000';
const CLIENT_ID = store.get('clientId') || uuidv4();
const CLIENT_NAME = store.get('clientName') || `Player-${CLIENT_ID.slice(0, 6)}`;

// 설정 저장
store.set('clientId', CLIENT_ID);
store.set('clientName', CLIENT_NAME);

let windows = [];
let ws = null;
let reconnectTimer = null;

// ─── 윈도우 생성 ─────────────────────────────────────────
function createPlayerWindows() {
  const displays = screen.getAllDisplays();
  const monitorCount = Math.min(displays.length, 2); // 최대 2대

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
    windows.push(win);
  }

  return monitorCount;
}

// ─── WebSocket 연결 ──────────────────────────────────────
function connectToHost() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log(`[WS] 호스트 연결 시도: ${HOST_URL}`);
  ws = new WebSocket(HOST_URL);

  ws.on('open', () => {
    console.log('[WS] 호스트 연결 성공');
    clearInterval(reconnectTimer);

    // 핸드셰이크: 등록 메시지 전송
    const monitorCount = windows.length || 1;
    ws.send(JSON.stringify({
      type: 'register',
      clientId: CLIENT_ID,
      name: CLIENT_NAME,
      monitors: monitorCount
    }));

    // 하트비트 시작
    startHeartbeat();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleCommand(msg);
    } catch (e) {
      console.error('[WS] 메시지 파싱 오류:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 연결 끊김. 5초 후 재연결...');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[WS] 오류:', err.message);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearInterval(reconnectTimer);
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
      ws.send(JSON.stringify({ type: 'heartbeat', clientId: CLIENT_ID }));
    }
  }, 10000);
}

// ─── 명령 처리 ───────────────────────────────────────────
function handleCommand(msg) {
  switch (msg.type) {
    case 'registered':
      console.log(`[CMD] 등록 확인: ${msg.message}`);
      // 대기 화면 표시
      windows.forEach(win => {
        win.webContents.send('show-standby', { name: CLIENT_NAME, id: CLIENT_ID });
      });
      break;

    case 'play':
      console.log(`[CMD] 재생 명령 수신: ${msg.files.length}개 파일`);
      playContent(msg.files);
      break;

    case 'stop':
      console.log('[CMD] 정지 명령 수신');
      stopContent();
      break;
  }
}

function playContent(files) {
  const hostHttp = HOST_URL.replace('ws://', 'http://').replace('wss://', 'https://');

  if (windows.length === 1) {
    // 모니터 1대: 모든 파일을 순차 재생 (슬라이드쇼)
    const urls = files.map(f => `${hostHttp}${f.url}`);
    windows[0].webContents.send('play', {
      files: files.map(f => ({
        url: `${hostHttp}${f.url}`,
        mimeType: f.mimeType,
        originalName: f.originalName
      })),
      mode: 'sequential'
    });
  } else if (windows.length >= 2) {
    // 모니터 2대: 각 모니터에 1개씩 배분
    files.forEach((f, idx) => {
      if (idx < windows.length) {
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

function stopContent() {
  windows.forEach(win => {
    win.webContents.send('stop');
  });
}

// ─── 앱 라이프사이클 ─────────────────────────────────────
app.whenReady().then(() => {
  createPlayerWindows();
  connectToHost();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ESC 키로 종료 허용 (개발/디버그용)
app.on('browser-window-created', (_, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      app.quit();
    }
  });
});
