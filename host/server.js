/**
 * 디지털 게시판 호스트 서버 (v2 — 편성표 + 푸시)
 * - 클라이언트 플레이어 등록/인식 (WebSocket 핸드셰이크)
 * - 콘텐츠 파일 업로드 (로컬 + 구글 드라이브 자동 동기화)
 * - 편성표(큐시트) 관리 및 클라이언트 푸시
 * - 즉시 동기화 명령 (sync_now)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const GDriveSync = require('./gdrive-sync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SCHEDULE_FILE = path.join(__dirname, 'data', 'schedule.json');

// 업로드 디렉토리 확인
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
// 데이터 디렉토리 확인
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ─── 상태 관리 ───────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, name, monitors, status, lastSeen, scheduleVersion }
const contentFiles = []; // { id, originalName, filename, size, mimeType, source, uploadedAt }

// ─── 편성표 관리 ────────────────────────────────────────
let scheduleData = { version: 0, entries: [] };

function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      console.log(`[Schedule] 로드: 버전 ${scheduleData.version}, ${scheduleData.entries.length}개 항목`);
    }
  } catch (e) {
    console.warn('[Schedule] 로드 실패:', e.message);
  }
}

function saveSchedule() {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
  } catch (e) {
    console.error('[Schedule] 저장 실패:', e.message);
  }
}

loadSchedule();

// ─── 구글 드라이브 동기화 ────────────────────────────────
const gdrive = new GDriveSync({
  credentialsPath: path.join(__dirname, 'credentials', 'service-account.json'),
  folderId: process.env.GDRIVE_FOLDER_ID || '1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm',
  downloadDir: UPLOADS_DIR,
  syncInterval: 3 * 60 * 1000, // 3분
  onSyncComplete: (driveFiles) => {
    // 드라이브 파일 목록을 contentFiles에 반영
    for (let i = contentFiles.length - 1; i >= 0; i--) {
      if (contentFiles[i].source === 'gdrive') {
        contentFiles.splice(i, 1);
      }
    }
    driveFiles.forEach(f => {
      contentFiles.push({
        id: f.driveId,
        originalName: f.originalName,
        filename: f.filename,
        mimeType: f.mimeType,
        url: f.url,
        source: 'gdrive',
        uploadedAt: f.modifiedTime
      });
    });
    broadcastToAdmins({ type: 'content_update' });
    console.log(`[Server] 콘텐츠 목록 갱신: 로컬 ${contentFiles.filter(f => f.source !== 'gdrive').length}개 + 드라이브 ${driveFiles.length}개`);
  }
});

// 드라이브 초기화 (비동기, 실패해도 서버는 동작)
(async () => {
  const ok = await gdrive.initialize();
  if (ok) {
    gdrive.startAutoSync();
  } else {
    console.warn('[Server] 구글 드라이브 연동 실패 — 로컬 업로드만 사용 가능');
  }
})();

// ─── 미들웨어 ────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── 파일 업로드 설정 ────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// ─── REST API ────────────────────────────────────────────

// 클라이언트 목록 조회
app.get('/api/clients', (req, res) => {
  const list = [];
  clients.forEach((info, id) => {
    list.push({
      id,
      name: info.name,
      monitors: info.monitors,
      status: info.ws.readyState === WebSocket.OPEN ? 'online' : 'offline',
      lastSeen: info.lastSeen,
      scheduleVersion: info.scheduleVersion || 0
    });
  });
  res.json(list);
});

// 콘텐츠 업로드 (로컬)
app.post('/api/upload', upload.array('files', 20), (req, res) => {
  const uploaded = req.files.map(f => {
    const entry = {
      id: uuidv4(),
      originalName: f.originalname,
      filename: f.filename,
      size: f.size,
      mimeType: f.mimetype,
      source: 'local',
      uploadedAt: new Date().toISOString()
    };
    contentFiles.push(entry);
    return entry;
  });
  broadcastToAdmins({ type: 'content_update' });
  res.json({ success: true, files: uploaded });
});

// 콘텐츠 목록 조회
app.get('/api/content', (req, res) => {
  res.json(contentFiles);
});

// 콘텐츠 삭제
app.delete('/api/content/:id', (req, res) => {
  const idx = contentFiles.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = contentFiles.splice(idx, 1);
  if (removed.source === 'local') {
    const filePath = path.join(UPLOADS_DIR, removed.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  broadcastToAdmins({ type: 'content_update' });
  res.json({ success: true });
});

// ─── 편성표 API ─────────────────────────────────────────

// 편성표 조회
app.get('/api/schedule', (req, res) => {
  res.json(scheduleData);
});

// 편성표 저장 (전체 교체)
app.put('/api/schedule', (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries 배열이 필요합니다.' });
  }

  scheduleData.entries = entries;
  scheduleData.version = Date.now();
  saveSchedule();

  console.log(`[Schedule] 저장: 버전 ${scheduleData.version}, ${entries.length}개 항목`);

  // 모든 연결된 클라이언트에 편성표 푸시
  pushScheduleToClients();

  broadcastToAdmins({ type: 'schedule_update', schedule: scheduleData });
  res.json({ success: true, version: scheduleData.version });
});

// 편성표 적용 (클라이언트에 푸시)
app.post('/api/schedule/apply', (req, res) => {
  pushScheduleToClients();
  // 동시에 드라이브 동기화 명령도 전송
  pushSyncNowToClients();
  res.json({ success: true, message: '편성표 및 동기화 명령 전송 완료' });
});

// ─── 재생 명령 전송 (수동 제어) ─────────────────────────
app.post('/api/play', (req, res) => {
  const { clientId, files } = req.body;

  if (!clientId || !files || files.length === 0) {
    return res.status(400).json({ error: 'clientId와 files가 필요합니다.' });
  }

  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }

  const command = {
    type: 'play',
    files: files.map(f => ({
      url: `/uploads/${f.filename}`,
      originalName: f.originalName,
      mimeType: f.mimeType
    }))
  };

  client.ws.send(JSON.stringify(command));
  res.json({ success: true, message: '재생 명령 전송 완료' });
});

// 정지 명령 전송
app.post('/api/stop', (req, res) => {
  const { clientId } = req.body;
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }
  client.ws.send(JSON.stringify({ type: 'stop' }));
  res.json({ success: true });
});

// 구글 드라이브 상태 조회
app.get('/api/gdrive/status', (req, res) => {
  res.json(gdrive.getStatus());
});

// 구글 드라이브 수동 동기화 트리거
app.post('/api/gdrive/sync', async (req, res) => {
  await gdrive.sync();
  // 클라이언트에도 동기화 명령 전송
  pushSyncNowToClients();
  res.json({ success: true, status: gdrive.getStatus() });
});

// ─── WebSocket 핸드셰이크 ────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] 새 연결 수립');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        const clientId = msg.clientId || uuidv4();
        const clientName = msg.name || `Player-${clientId.slice(0, 6)}`;
        const monitors = msg.monitors || 1;
        const scheduleVersion = msg.scheduleVersion || 0;

        clients.set(clientId, {
          ws,
          name: clientName,
          monitors,
          lastSeen: new Date().toISOString(),
          scheduleVersion
        });

        // 등록 확인 응답
        ws.send(JSON.stringify({
          type: 'registered',
          clientId,
          name: clientName,
          message: '호스트에 등록되었습니다.'
        }));

        console.log(`[WS] 클라이언트 등록: ${clientName} (${clientId}), 모니터: ${monitors}대`);

        // 편성표가 있고, 클라이언트 버전이 낮으면 즉시 푸시
        if (scheduleData.entries.length > 0 && scheduleVersion < scheduleData.version) {
          ws.send(JSON.stringify({
            type: 'schedule_update',
            schedule: scheduleData
          }));
          console.log(`[WS] 편성표 푸시 → ${clientName} (v${scheduleData.version})`);
        }

        broadcastToAdmins({ type: 'client_update' });
      }

      if (msg.type === 'heartbeat') {
        const client = clients.get(msg.clientId);
        if (client) {
          client.lastSeen = new Date().toISOString();
          client.scheduleVersion = msg.scheduleVersion || 0;
        }
      }

      if (msg.type === 'admin_subscribe') {
        ws._isAdmin = true;
      }

    } catch (e) {
      console.error('[WS] 메시지 파싱 오류:', e.message);
    }
  });

  ws.on('close', () => {
    clients.forEach((info, id) => {
      if (info.ws === ws) {
        console.log(`[WS] 클라이언트 연결 끊김: ${info.name} (${id})`);
        broadcastToAdmins({ type: 'client_update' });
      }
    });
  });
});

// ─── 헬퍼 함수 ──────────────────────────────────────────

function broadcastToAdmins(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client._isAdmin && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

/**
 * 모든 연결된 클라이언트에 편성표 푸시
 */
function pushScheduleToClients() {
  const msg = JSON.stringify({
    type: 'schedule_update',
    schedule: scheduleData
  });

  let count = 0;
  clients.forEach((info, id) => {
    if (info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(msg);
      count++;
    }
  });
  console.log(`[Schedule] 편성표 푸시 → ${count}개 클라이언트`);
}

/**
 * 모든 연결된 클라이언트에 즉시 동기화 명령 전송
 */
function pushSyncNowToClients() {
  const msg = JSON.stringify({ type: 'sync_now' });

  clients.forEach((info, id) => {
    if (info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(msg);
    }
  });
  console.log('[Sync] 즉시 동기화 명령 전송');
}

// ─── 서버 시작 ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  디지털 게시판 호스트 서버 v2 시작        ║`);
  console.log(`║  http://localhost:${PORT}                  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
