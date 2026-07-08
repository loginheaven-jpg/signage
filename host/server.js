/**
 * 디지털 게시판 호스트 서버 (MVP + 구글 드라이브 연동)
 * - 클라이언트 플레이어 등록/인식 (WebSocket 핸드셰이크)
 * - 콘텐츠 파일 업로드 (로컬 + 구글 드라이브 자동 동기화)
 * - 특정 클라이언트에 재생 명령 전송
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

// 업로드 디렉토리 확인
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── 상태 관리 ───────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, name, monitors, status, lastSeen }
const contentFiles = []; // { id, originalName, filename, size, mimeType, source, uploadedAt }

// ─── 구글 드라이브 동기화 ────────────────────────────────
const gdrive = new GDriveSync({
  credentialsPath: path.join(__dirname, 'credentials', 'service-account.json'),
  folderId: process.env.GDRIVE_FOLDER_ID || '1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm',
  downloadDir: UPLOADS_DIR,
  syncInterval: 3 * 60 * 1000, // 3분
  onSyncComplete: (driveFiles) => {
    // 드라이브 파일 목록을 contentFiles에 반영
    // 기존 gdrive 소스 파일 제거
    for (let i = contentFiles.length - 1; i >= 0; i--) {
      if (contentFiles[i].source === 'gdrive') {
        contentFiles.splice(i, 1);
      }
    }
    // 새로 추가
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
    // 관리자 UI에 알림
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
      lastSeen: info.lastSeen
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
  // 로컬 파일만 삭제 (드라이브 파일은 드라이브에서 삭제해야 함)
  if (removed.source === 'local') {
    const filePath = path.join(UPLOADS_DIR, removed.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  broadcastToAdmins({ type: 'content_update' });
  res.json({ success: true });
});

// 재생 명령 전송
app.post('/api/play', (req, res) => {
  const { clientId, files } = req.body;
  // files: [{ filename, originalName, mimeType }] — 1개 또는 2개(듀얼)

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
  res.json({ success: true, status: gdrive.getStatus() });
});

// ─── WebSocket 핸드셰이크 ────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] 새 연결 수립');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        // 클라이언트 등록 (핸드셰이크)
        const clientId = msg.clientId || uuidv4();
        const clientName = msg.name || `Player-${clientId.slice(0, 6)}`;
        const monitors = msg.monitors || 1;

        clients.set(clientId, {
          ws,
          name: clientName,
          monitors,
          lastSeen: new Date().toISOString()
        });

        // 등록 확인 응답
        ws.send(JSON.stringify({
          type: 'registered',
          clientId,
          name: clientName,
          message: '호스트에 등록되었습니다.'
        }));

        console.log(`[WS] 클라이언트 등록: ${clientName} (${clientId}), 모니터: ${monitors}대`);

        // 관리자 UI에 알림
        broadcastToAdmins({ type: 'client_update' });
      }

      if (msg.type === 'heartbeat') {
        const client = clients.get(msg.clientId);
        if (client) {
          client.lastSeen = new Date().toISOString();
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

function broadcastToAdmins(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client._isAdmin && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ─── 서버 시작 ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  디지털 게시판 호스트 서버 시작           ║`);
  console.log(`║  http://localhost:${PORT}                  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
