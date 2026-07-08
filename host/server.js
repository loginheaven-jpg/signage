/**
 * 디지털 게시판 호스트 서버 (v3 — 다중 사이트 + 확장 편성표)
 * - 다중 사이트 관리 (현관, 식당 등)
 * - 사이트별 편성표 (큐시트) 관리
 * - 편성표 확장 스키마: 편성유형, 소리, 전환효과, 유효기간, 활성/비활성
 * - 사이트별 클라이언트 푸시
 * - 클라이언트 플레이어 등록/인식 (WebSocket 핸드셰이크)
 * - 콘텐츠 파일 업로드 (로컬 + 구글 드라이브 자동 동기화)
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
const DATA_DIR = path.join(__dirname, 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

// 디렉토리 확인
[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── 상태 관리 ───────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, name, monitors, siteId, lastSeen, scheduleVersion, currentPlaying }
const contentFiles = []; // { id, originalName, filename, size, mimeType, source, uploadedAt }

// ─── 사이트 관리 ────────────────────────────────────────
let sites = [];

function loadSites() {
  try {
    if (fs.existsSync(SITES_FILE)) {
      sites = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
      console.log(`[Sites] 로드: ${sites.length}개 사이트`);
    } else {
      sites = [];
      saveSites();
    }
  } catch (e) {
    console.warn('[Sites] 로드 실패:', e.message);
    sites = [];
  }
}

function saveSites() {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2));
}

loadSites();

// ─── 편성표 관리 (사이트별) ────────────────────────────────
let scheduleData = { version: 0, entries: [] };

function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      // 기존 데이터 마이그레이션: siteId 없는 항목에 기본값 추가
      scheduleData.entries = (scheduleData.entries || []).map(entry => ({
        siteId: entry.siteId || (sites.length > 0 ? sites[0].id : ''),
        layoutType: 'independent',
        audio: 'none',
        transition: 'fade',
        validFrom: null,
        validTo: null,
        enabled: true,
        ...entry
      }));
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
  syncInterval: 3 * 60 * 1000,
  onSyncComplete: (driveFiles) => {
    for (let i = contentFiles.length - 1; i >= 0; i--) {
      if (contentFiles[i].source === 'gdrive') contentFiles.splice(i, 1);
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
    console.log(`[Server] 콘텐츠 갱신: 로컬 ${contentFiles.filter(f => f.source !== 'gdrive').length}개 + 드라이브 ${driveFiles.length}개`);
  }
});

(async () => {
  const ok = await gdrive.initialize();
  if (ok) gdrive.startAutoSync();
  else console.warn('[Server] 구글 드라이브 연동 실패 — 로컬 업로드만 사용 가능');
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
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════

// ─── 사이트 관리 API ────────────────────────────────────

app.get('/api/sites', (req, res) => {
  const sitesWithStatus = sites.map(site => {
    const siteClients = [];
    clients.forEach((info, id) => {
      if (info.siteId === site.id) {
        siteClients.push({
          id, name: info.name,
          online: info.ws.readyState === WebSocket.OPEN,
          lastSeen: info.lastSeen,
          currentPlaying: info.currentPlaying || null
        });
      }
    });
    return {
      ...site,
      clients: siteClients,
      online: siteClients.some(c => c.online),
      clientCount: siteClients.length
    };
  });
  res.json(sitesWithStatus);
});

app.post('/api/sites', (req, res) => {
  const { name, icon, monitors, description } = req.body;
  if (!name) return res.status(400).json({ error: '사이트 이름이 필요합니다.' });
  const id = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '_') + '_' + Date.now().toString(36);
  const newSite = { id, name, icon: icon || '📺', monitors: monitors || 1, description: description || '' };
  sites.push(newSite);
  saveSites();
  broadcastToAdmins({ type: 'sites_update' });
  res.json({ success: true, site: newSite });
});

app.put('/api/sites/:id', (req, res) => {
  const idx = sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '사이트를 찾을 수 없습니다.' });
  const { name, icon, monitors, description } = req.body;
  if (name) sites[idx].name = name;
  if (icon) sites[idx].icon = icon;
  if (monitors) sites[idx].monitors = monitors;
  if (description !== undefined) sites[idx].description = description;
  saveSites();
  broadcastToAdmins({ type: 'sites_update' });
  res.json({ success: true, site: sites[idx] });
});

app.delete('/api/sites/:id', (req, res) => {
  const idx = sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '사이트를 찾을 수 없습니다.' });
  sites.splice(idx, 1);
  scheduleData.entries = scheduleData.entries.filter(e => e.siteId !== req.params.id);
  scheduleData.version = Date.now();
  saveSchedule();
  saveSites();
  broadcastToAdmins({ type: 'sites_update' });
  res.json({ success: true });
});

// ─── 클라이언트 API ────────────────────────────────────

// 승인된 클라이언트 목록 (영구 저장)
const APPROVED_FILE = path.join(DATA_DIR, 'approved-clients.json');
let approvedClients = {}; // clientId -> { name, siteId, approvedAt }

function loadApproved() {
  try {
    if (fs.existsSync(APPROVED_FILE)) {
      approvedClients = JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf8'));
      console.log(`[Clients] 승인 목록 로드: ${Object.keys(approvedClients).length}개`);
    }
  } catch (e) { approvedClients = {}; }
}
function saveApproved() {
  try { fs.writeFileSync(APPROVED_FILE, JSON.stringify(approvedClients, null, 2)); } catch (e) {}
}
loadApproved();

app.get('/api/clients', (req, res) => {
  const list = [];
  clients.forEach((info, id) => {
    const isApproved = !!approvedClients[id];
    list.push({
      id, name: info.name, monitors: info.monitors,
      siteId: info.siteId || (approvedClients[id]?.siteId) || null,
      approved: isApproved,
      status: info.ws.readyState === WebSocket.OPEN ? 'online' : 'offline',
      lastSeen: info.lastSeen,
      scheduleVersion: info.scheduleVersion || 0,
      currentPlaying: info.currentPlaying || null
    });
  });
  res.json(list);
});

// 클라이언트 승인
app.post('/api/clients/:id/approve', (req, res) => {
  let { siteId } = req.body;
  const client = clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: '클라이언트를 찾을 수 없습니다.' });

  // 사이트 미선택 시 클라이언트 이름으로 사이트 자동 생성
  if (!siteId) {
    const autoSiteId = `site_${req.params.id.slice(0, 8)}`;
    const existing = sites.find(s => s.id === autoSiteId);
    if (!existing) {
      sites.push({
        id: autoSiteId,
        name: client.name,
        icon: '📺',
        monitors: client.monitors || 1,
        description: `${client.name} 클라이언트 자동 생성`
      });
      saveSites();
      broadcastToAdmins({ type: 'sites_update' });
    }
    siteId = autoSiteId;
  }

  client.siteId = siteId;
  approvedClients[req.params.id] = {
    name: client.name,
    siteId: siteId,
    approvedAt: new Date().toISOString()
  };
  saveApproved();

  // 클라이언트에 승인 메시지 전송
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ type: 'approved', siteId: siteId || null }));
    // 편성표도 즉시 전송
    if (siteId) {
      const siteSchedule = getSiteSchedule(siteId);
      client.ws.send(JSON.stringify({ type: 'schedule_update', schedule: siteSchedule }));
    }
  }

  broadcastToAdmins({ type: 'client_update' });
  console.log(`[Clients] 승인: ${client.name} (${req.params.id}) → 사이트: ${siteId || '미지정'}`);
  res.json({ success: true });
});

// 클라이언트 거부 (등록 해제)
app.post('/api/clients/:id/reject', (req, res) => {
  const client = clients.get(req.params.id);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ type: 'rejected' }));
  }
  delete approvedClients[req.params.id];
  saveApproved();
  clients.delete(req.params.id);
  broadcastToAdmins({ type: 'client_update' });
  console.log(`[Clients] 거부/삭제: ${req.params.id}`);
  res.json({ success: true });
});

app.put('/api/clients/:id/site', (req, res) => {
  const { siteId } = req.body;
  const client = clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: '클라이언트를 찾을 수 없습니다.' });
  client.siteId = siteId;
  if (approvedClients[req.params.id]) {
    approvedClients[req.params.id].siteId = siteId;
    saveApproved();
  }
  broadcastToAdmins({ type: 'client_update' });
  if (siteId && client.ws.readyState === WebSocket.OPEN) {
    const siteSchedule = getSiteSchedule(siteId);
    client.ws.send(JSON.stringify({ type: 'schedule_update', schedule: siteSchedule }));
  }
  res.json({ success: true });
});

// ─── 콘텐츠 API ────────────────────────────────────────

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  const uploaded = req.files.map(f => {
    const entry = {
      id: uuidv4(), originalName: f.originalname, filename: f.filename,
      size: f.size, mimeType: f.mimetype, source: 'local',
      uploadedAt: new Date().toISOString()
    };
    contentFiles.push(entry);
    return entry;
  });
  broadcastToAdmins({ type: 'content_update' });
  res.json({ success: true, files: uploaded });
});

app.get('/api/content', (req, res) => {
  res.json(contentFiles);
});

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

// ─── 편성표 API (확장) ─────────────────────────────────

app.get('/api/schedule', (req, res) => {
  res.json(scheduleData);
});

app.get('/api/schedule/:siteId', (req, res) => {
  res.json(getSiteSchedule(req.params.siteId));
});

app.put('/api/schedule', (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries 배열이 필요합니다.' });

  scheduleData.entries = entries.map(entry => ({
    siteId: 'entrance',
    layoutType: 'independent',
    audio: 'none',
    transition: 'fade',
    validFrom: null,
    validTo: null,
    enabled: true,
    ...entry
  }));
  scheduleData.version = Date.now();
  saveSchedule();

  console.log(`[Schedule] 저장: 버전 ${scheduleData.version}, ${entries.length}개 항목`);
  pushScheduleToAllClients();
  broadcastToAdmins({ type: 'schedule_update', schedule: scheduleData });
  res.json({ success: true, version: scheduleData.version });
});

app.post('/api/schedule/apply', (req, res) => {
  pushScheduleToAllClients();
  pushSyncNowToClients();
  res.json({ success: true, message: '편성표 및 동기화 명령 전송 완료' });
});

app.post('/api/schedule/:siteId/apply', (req, res) => {
  pushScheduleToSiteClients(req.params.siteId);
  pushSyncNowToClients(req.params.siteId);
  res.json({ success: true, message: `${req.params.siteId} 사이트 편성표 적용 완료` });
});

// ─── 재생 제어 API ──────────────────────────────────────

app.post('/api/play', (req, res) => {
  const { clientId, files } = req.body;
  if (!clientId || !files || files.length === 0) return res.status(400).json({ error: 'clientId와 files가 필요합니다.' });
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  client.ws.send(JSON.stringify({
    type: 'play',
    files: files.map(f => ({ url: `/uploads/${f.filename}`, originalName: f.originalName, mimeType: f.mimeType }))
  }));
  res.json({ success: true, message: '재생 명령 전송 완료' });
});

app.post('/api/stop', (req, res) => {
  const { clientId } = req.body;
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  client.ws.send(JSON.stringify({ type: 'stop' }));
  res.json({ success: true });
});

// ─── 구글 드라이브 API ──────────────────────────────────

app.get('/api/gdrive/status', (req, res) => {
  res.json(gdrive.getStatus());
});

app.post('/api/gdrive/sync', async (req, res) => {
  await gdrive.sync();
  pushSyncNowToClients();
  res.json({ success: true, status: gdrive.getStatus() });
});

// ─── WebSocket ──────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] 새 연결 수립');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        const clientId = msg.clientId || uuidv4();
        const clientName = msg.name || `Player-${clientId.slice(0, 6)}`;
        const monitors = msg.monitors || 1;
        const siteId = msg.siteId || null;
        const scheduleVersion = msg.scheduleVersion || 0;

        // 이전 승인 여부 확인
        const wasApproved = !!approvedClients[clientId];
        const assignedSiteId = wasApproved ? (approvedClients[clientId].siteId || siteId) : siteId;

        clients.set(clientId, {
          ws, name: clientName, monitors, siteId: assignedSiteId,
          lastSeen: new Date().toISOString(),
          scheduleVersion, currentPlaying: null,
          approved: wasApproved
        });

        ws.send(JSON.stringify({ type: 'registered', clientId, name: clientName, message: '호스트에 등록되었습니다.' }));
        console.log(`[WS] 클라이언트 등록: ${clientName} (${clientId}), 모니터: ${monitors}대, 사이트: ${assignedSiteId || '미지정'}, 승인: ${wasApproved}`);

        // 승인된 클라이언트면 즉시 approved + 편성표 전송
        if (wasApproved) {
          ws.send(JSON.stringify({ type: 'approved', siteId: assignedSiteId }));
          if (assignedSiteId) {
            const siteSchedule = getSiteSchedule(assignedSiteId);
            if (siteSchedule.entries.length > 0) {
              ws.send(JSON.stringify({ type: 'schedule_update', schedule: siteSchedule }));
            }
          } else if (scheduleData.entries.length > 0) {
            ws.send(JSON.stringify({ type: 'schedule_update', schedule: scheduleData }));
          }
        }
        // 미승인이면 pending 상태 유지 (클라이언트는 대기 화면)

        broadcastToAdmins({ type: 'client_update' });
      }

      if (msg.type === 'heartbeat') {
        const client = clients.get(msg.clientId);
        if (client) {
          client.lastSeen = new Date().toISOString();
          client.scheduleVersion = msg.scheduleVersion || 0;
          if (msg.currentPlaying !== undefined) client.currentPlaying = msg.currentPlaying;
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
    if (client._isAdmin && client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function getSiteSchedule(siteId) {
  const now = new Date();
  const entries = scheduleData.entries.filter(e => {
    if (e.siteId !== siteId) return false;
    if (!e.enabled) return false;
    if (e.validFrom && new Date(e.validFrom) > now) return false;
    if (e.validTo && new Date(e.validTo) < now) return false;
    return true;
  });
  return { version: scheduleData.version, entries };
}

function pushScheduleToAllClients() {
  let count = 0;
  clients.forEach((info) => {
    if (info.ws.readyState === WebSocket.OPEN) {
      const schedule = info.siteId ? getSiteSchedule(info.siteId) : scheduleData;
      info.ws.send(JSON.stringify({ type: 'schedule_update', schedule }));
      count++;
    }
  });
  console.log(`[Schedule] 편성표 푸시 → ${count}개 클라이언트`);
}

function pushScheduleToSiteClients(siteId) {
  const siteSchedule = getSiteSchedule(siteId);
  const msg = JSON.stringify({ type: 'schedule_update', schedule: siteSchedule });
  let count = 0;
  clients.forEach((info) => {
    if (info.siteId === siteId && info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(msg);
      count++;
    }
  });
  console.log(`[Schedule] 사이트 ${siteId} 편성표 푸시 → ${count}개 클라이언트`);
}

function pushSyncNowToClients(siteId) {
  const msg = JSON.stringify({ type: 'sync_now' });
  clients.forEach((info) => {
    if (info.ws.readyState === WebSocket.OPEN) {
      if (!siteId || info.siteId === siteId) info.ws.send(msg);
    }
  });
  console.log(`[Sync] 즉시 동기화 명령 전송${siteId ? ` (사이트: ${siteId})` : ''}`);
}

// ─── 서버 시작 ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  디지털 게시판 호스트 서버 v3 시작        ║`);
  console.log(`║  http://localhost:${PORT}                  ║`);
  console.log(`║  사이트: ${sites.map(s => s.name).join(', ')}             ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
