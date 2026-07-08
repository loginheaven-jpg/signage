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

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
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

// ─── 윈도우 관리 ────────────────────────────────────────
let mainWindow = null;
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;

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

  // 설정이 없으면 설정 화면, 있으면 플레이어 화면
  if (!config.clientName || !config.hostUrl) {
    mainWindow.loadFile('setup.html');
  } else if (!config.approved) {
    mainWindow.loadFile('waiting.html');
    connectToHost();
  } else {
    mainWindow.loadFile('player.html');
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

// 현재 설정 조회
ipcMain.handle('get-config', async () => {
  return config;
});

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
      }, 1000);
      break;

    case 'rejected':
      // 호스트에서 거부됨
      console.log('[WS] 거부됨');
      config.approved = false;
      config.siteId = '';
      saveConfig();
      mainWindow.loadFile('waiting.html');
      break;

    case 'schedule_update':
      // 편성표 수신
      console.log(`[WS] 편성표 수신: v${msg.schedule?.version}`);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('schedule-update', msg.schedule);
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
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        clientId: config.clientId,
        scheduleVersion: 0
      }));
    }
  }, 30000);
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
