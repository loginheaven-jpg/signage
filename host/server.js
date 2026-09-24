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

// 영구 데이터 경로 — 재배포와 무관하게 보존되어야 하는 상태(사이트/편성표/승인 클라이언트)
// Railway 등 ephemeral 환경에서는 영구 볼륨을 마운트하고 DATA_DIR/UPLOADS_DIR 환경변수로 지정한다.
// 예) 볼륨을 /data 에 마운트 후  DATA_DIR=/data  UPLOADS_DIR=/data/uploads
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

// 디렉토리 확인
[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
console.log(`[Storage] DATA_DIR=${DATA_DIR}`);
console.log(`[Storage] UPLOADS_DIR=${UPLOADS_DIR}`);
if (!process.env.DATA_DIR) {
  console.warn('[Storage] ⚠ DATA_DIR 미설정 — 로컬 경로 사용 중. Railway 등 배포 환경에서는 영구 볼륨을 마운트하고 DATA_DIR을 지정하지 않으면 재배포 시 데이터가 초기화됩니다.');
}

// ─── 상태 관리 ───────────────────────────────────────────
const clients = new Map(); // clientId -> { ws, name, monitors, siteId, lastSeen, scheduleVersion, currentPlaying }
const contentFiles = []; // { id, originalName, filename, size, mimeType, source, uploadedAt }

// 로컬 업로드 콘텐츠 목록 영속화 (드라이브 콘텐츠는 동기화로 재생성되므로 제외)
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

function loadLocalContent() {
  try {
    if (fs.existsSync(CONTENT_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
      let restored = 0;
      saved.forEach(f => {
        // 파일이 실제로 남아있는 항목만 복원
        if (f.source === 'local' && fs.existsSync(path.join(UPLOADS_DIR, f.filename))) {
          contentFiles.push(f);
          restored++;
        }
      });
      console.log(`[Content] 로컬 콘텐츠 복원: ${restored}개`);
    }
  } catch (e) {
    console.warn('[Content] 로컬 콘텐츠 로드 실패:', e.message);
  }
}

function saveLocalContent() {
  try {
    const local = contentFiles.filter(f => f.source === 'local');
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(local, null, 2));
  } catch (e) {
    console.error('[Content] 로컬 콘텐츠 저장 실패:', e.message);
  }
}

loadLocalContent();

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

// ─── 관리자 인증 (선택) ──────────────────────────────────
// ADMIN_PASSWORD 환경변수가 설정되면 관리 UI(/)와 모든 /api 호출에 HTTP Basic 인증을 요구한다.
// 미설정 시 인증 없이 동작(로컬 개발/기존 배포 호환).
// 클라이언트가 쓰는 /uploads, /player.html, WebSocket 은 인증 대상이 아니다.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function checkAuth(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  const m = h.match(/^Basic (.+)$/);
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

function requireAuth(req, res, next) {
  if (checkAuth(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Signage Admin"');
  return res.status(401).send('인증이 필요합니다.');
}

// ─── 미들웨어 ────────────────────────────────────────────
app.use(express.json());

// 관리 UI 는 인증 뒤에서 제공 (정적 미들웨어보다 먼저 등록)
app.get(['/', '/index.html'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 웹 플레이어 — 인증 없이 접근 (확장자 없는 /player 별칭)
app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// 모든 API 는 인증 필요
app.use('/api', requireAuth);

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
  // 같은 이름의 사이트 중복 생성 방지
  if (sites.some(s => s.name === name.trim())) {
    return res.status(409).json({ error: '같은 이름의 사이트가 이미 있습니다.' });
  }
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

// 한 사이트 = 한 클라이언트. 해당 사이트에 이미 연결된 다른 클라이언트를 해제한다.
// (온라인이면 대기 화면으로 되돌리고, 오프라인이면 목록에서 제거)
function releaseSiteOccupants(siteId, exceptId) {
  if (!siteId) return [];
  const released = [];
  // 승인 목록에서 해제
  Object.keys(approvedClients).forEach(cid => {
    if (cid !== exceptId && approvedClients[cid].siteId === siteId) {
      released.push({ id: cid, name: approvedClients[cid].name });
      delete approvedClients[cid];
    }
  });
  // 접속 중인 클라이언트 처리
  clients.forEach((info, cid) => {
    if (cid !== exceptId && info.siteId === siteId) {
      const online = info.ws && info.ws.readyState === WebSocket.OPEN;
      if (online) {
        info.ws.send(JSON.stringify({ type: 'rejected' })); // 대기 화면으로
        info.approved = false;
        info.siteId = null;
      } else {
        clients.delete(cid); // 오프라인이면 목록에서 제거
      }
      if (!released.find(r => r.id === cid)) released.push({ id: cid, name: info.name });
    }
  });
  if (released.length) saveApproved();
  return released;
}

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

  // 사이트 미선택 시: 같은 이름의 사이트가 있으면 재사용, 없으면 자동 생성
  // (관리자가 미리 만든 사이트와 클라이언트 자동생성 사이트가 중복되지 않도록)
  if (!siteId) {
    const existingByName = sites.find(s => s.name === client.name);
    if (existingByName) {
      siteId = existingByName.id;
    } else {
      const autoSiteId = `site_${req.params.id.slice(0, 8)}`;
      if (!sites.find(s => s.id === autoSiteId)) {
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
  }

  // 한 사이트 = 한 클라이언트: 기존 연결 클라이언트가 있으면 해제
  const replaced = releaseSiteOccupants(siteId, req.params.id);

  client.siteId = siteId;
  client.approved = true; // 런타임 승인 플래그 — 이후 편성표 푸시 대상에 포함
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
  broadcastToAdmins({ type: 'sites_update' });
  console.log(`[Clients] 승인: ${client.name} (${req.params.id}) → 사이트: ${siteId || '미지정'}${replaced.length ? ` (기존 ${replaced.map(r => r.name).join(',')} 해제)` : ''}`);
  res.json({ success: true, replaced });
});

// 클라이언트 앱 원격 종료 (앱 자체를 완전히 끔 — 특수 용도)
app.post('/api/clients/:id/quit', (req, res) => {
  const client = clients.get(req.params.id);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }
  client.ws.send(JSON.stringify({ type: 'quit' }));
  console.log(`[Clients] 원격 종료 명령: ${client.name} (${req.params.id})`);
  res.json({ success: true });
});

// 재생 중지 — 현재 재생만 끔 (앱·연결은 유지, "재생 종료" 화면). 재개 가능
app.post('/api/clients/:id/stop', (req, res) => {
  const client = clients.get(req.params.id);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }
  client.ws.send(JSON.stringify({ type: 'stop' }));
  client.currentPlaying = null;
  broadcastToAdmins({ type: 'client_update' });
  console.log(`[Clients] 재생 중지: ${client.name} (${req.params.id})`);
  res.json({ success: true });
});

// 재생 재개 — 해당 클라이언트에 사이트 편성표를 다시 전송
app.post('/api/clients/:id/resume', (req, res) => {
  const client = clients.get(req.params.id);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }
  if (!client.siteId) return res.status(400).json({ error: '사이트가 배정되지 않았습니다.' });
  const siteSchedule = getSiteSchedule(client.siteId);
  client.ws.send(JSON.stringify({ type: 'schedule_update', schedule: siteSchedule }));
  console.log(`[Clients] 재생 재개: ${client.name} (${req.params.id}) — ${siteSchedule.entries.length}개 항목`);
  res.json({ success: true, entries: siteSchedule.entries.length });
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

// 모든 클라이언트 등록/승인 초기화 (연결된 클라이언트는 대기 화면으로 되돌림)
app.post('/api/clients/reset', (req, res) => {
  let n = 0;
  clients.forEach((info) => {
    if (info.ws && info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(JSON.stringify({ type: 'rejected' }));
    }
    n++;
  });
  clients.clear();
  approvedClients = {};
  saveApproved();
  broadcastToAdmins({ type: 'client_update' });
  console.log(`[Reset] 클라이언트 전체 초기화: ${n}개`);
  res.json({ success: true, cleared: n });
});

// 전체 초기화 — 클라이언트 + 사이트 + 편성표를 모두 비운다 (완전 새출발)
app.post('/api/reset-all', (req, res) => {
  let n = 0;
  clients.forEach((info) => {
    if (info.ws && info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(JSON.stringify({ type: 'rejected' }));
    }
    n++;
  });
  clients.clear();
  approvedClients = {};
  saveApproved();
  sites = [];
  saveSites();
  scheduleData = { version: Date.now(), entries: [] };
  saveSchedule();
  broadcastToAdmins({ type: 'sites_update' });
  broadcastToAdmins({ type: 'client_update' });
  broadcastToAdmins({ type: 'schedule_update', schedule: scheduleData });
  console.log(`[Reset] 전체 초기화: 클라이언트 ${n}개 + 사이트/편성표 삭제`);
  res.json({ success: true, cleared: n });
});

app.put('/api/clients/:id/site', (req, res) => {
  const { siteId } = req.body;
  const client = clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: '클라이언트를 찾을 수 없습니다.' });
  // 한 사이트 = 한 클라이언트: 대상 사이트의 기존 클라이언트를 해제
  const replaced = releaseSiteOccupants(siteId, req.params.id);
  client.siteId = siteId;
  if (approvedClients[req.params.id]) {
    approvedClients[req.params.id].siteId = siteId;
    client.approved = true; // 이미 승인된 클라이언트의 사이트 재배정 — 승인 상태 유지
    saveApproved();
  }
  broadcastToAdmins({ type: 'client_update' });
  broadcastToAdmins({ type: 'sites_update' });
  if (siteId && client.ws.readyState === WebSocket.OPEN) {
    const siteSchedule = getSiteSchedule(siteId);
    client.ws.send(JSON.stringify({ type: 'schedule_update', schedule: siteSchedule }));
  }
  res.json({ success: true, replaced });
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
  saveLocalContent();
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
    saveLocalContent();
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
    siteId: entry.siteId || (sites.length > 0 ? sites[0].id : ''),
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

// ═══════════════════════════════════════════════════════════
// 라이브 사진 (폰 촬영 → 지정 모니터 즉시 송출)
// ═══════════════════════════════════════════════════════════
// 편성표를 건드리지 않는다. 클라이언트는 편성표를 계속 재생한 채
// 그 위에 '라이브 레이어'를 띄우고, 무입력이 일정 시간 이어지면 레이어만 사라진다.
//  - 폰 페이지: GET /m  (토큰 기반, 관리자 인증 없음)
//  - 폰 API   : /live/api/*  (토큰 검사)
//  - 관리 API : /api/live/*  (관리자 인증)

const crypto = require('crypto');
const LIVE_DIR = path.join(UPLOADS_DIR, 'live');
const LIVE_CONFIG_FILE = path.join(DATA_DIR, 'live.json');
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });

const LIVE_DEFAULT_SETTINGS = {
  heroMs: 8000,       // 새 사진 풀스크린(히어로) 표출 시간 — 대기 사진이 없을 때
  heroBusyMs: 4000,   // 대기 사진이 있을 때 단축된 히어로 시간
  returnMs: 50000,    // 이 시간 동안 새 사진이 없으면 편성표로 복귀
  cornerMs: 120000,   // 복귀 후 코너에 축소되어 남는 시간 (0이면 즉시 소멸)
  gridMax: 4,         // 그리드 최대 칸 수 (1→풀, 2→좌우, 3~4→2x2 적응)
  photoTtlMin: 180,   // 사진 보관 시간(분) — 지나면 파일까지 삭제
  cancelSec: 60       // 업로더 본인이 취소할 수 있는 시간(초)
};

let liveConfig = { enabled: false, token: '', settings: { ...LIVE_DEFAULT_SETTINGS } };

function newLiveToken() {
  return crypto.randomBytes(9).toString('base64url'); // 12자
}

function loadLiveConfig() {
  try {
    if (fs.existsSync(LIVE_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(LIVE_CONFIG_FILE, 'utf8'));
      liveConfig = {
        enabled: !!saved.enabled,
        token: saved.token || '',
        settings: { ...LIVE_DEFAULT_SETTINGS, ...(saved.settings || {}) }
      };
    }
  } catch (e) {
    console.warn('[Live] 설정 로드 실패:', e.message);
  }
  if (!liveConfig.token) { liveConfig.token = newLiveToken(); saveLiveConfig(); }
}

function saveLiveConfig() {
  try { fs.writeFileSync(LIVE_CONFIG_FILE, JSON.stringify(liveConfig, null, 2)); }
  catch (e) { console.error('[Live] 설정 저장 실패:', e.message); }
}

loadLiveConfig();
console.log(`[Live] 라이브 송출: ${liveConfig.enabled ? 'ON' : 'OFF'} — 폰 링크 /m?t=${liveConfig.token}`);

// 사이트별 라이브 세션. siteId -> { photos: [...], lastAt }
// photos[]: { id, filename, url, message, uploaderId, uploaderName, ts }
const liveSessions = new Map();
// 책임 추적용 최근 업로드 로그 (메모리, 최근 50건)
const liveUploadLog = [];

function liveSession(siteId) {
  if (!liveSessions.has(siteId)) liveSessions.set(siteId, { photos: [], lastAt: 0 });
  return liveSessions.get(siteId);
}

// 화면에 보내는 사진 정보 — 업로더 이름은 내보내지 않는다(화면에는 메시지만 표시).
function livePublicPhotos(session) {
  return session.photos.map(p => ({
    id: p.id, url: p.url, message: p.message || '', ts: p.ts,
    batchTotal: p.batchTotal || 1
  }));
}

function pushLive(siteId, msg) {
  const data = JSON.stringify(msg);
  let n = 0;
  clients.forEach((info) => {
    if (info.approved && info.siteId === siteId && info.ws.readyState === WebSocket.OPEN) {
      try { info.ws.send(data); n++; }
      catch (e) { console.warn('[Live] 전송 실패:', e.message); }
    }
  });
  return n;
}

// Socket 연결과 렌더러 준비는 다르다. 준비 완료/재접속 후 빠진 사진을 복원한다.
// 이미 표시한 사진은 반복하지 않고, 현재 라이브 시간 안에서만 재전송한다.
function syncLiveClient(info) {
  if (!liveConfig.enabled || !info.approved || !info.liveReady || info.ws.readyState !== WebSocket.OPEN) return;
  const session = liveSessions.get(info.siteId);
  if (!session || Date.now() - session.lastAt > liveConfig.settings.returnMs) return;
  for (const photo of session.photos) {
    if (Date.now() - photo.ts > liveConfig.settings.returnMs) continue;
    if (info.liveSeen.has(photo.id)) continue;
    const previous = info.liveAttempts.get(photo.id);
    if (previous && (previous.count >= 6 || Date.now() - previous.at < 5000)) continue;
    info.liveAttempts.set(photo.id, { at: Date.now(), count: (previous?.count || 0) + 1 });
    try {
      info.ws.send(JSON.stringify({ type: 'live_photo',
        photo: { id: photo.id, url: photo.url, message: photo.message, ts: photo.ts, batchTotal: photo.batchTotal },
        settings: liveConfig.settings }));
    } catch (e) { console.warn('[Live] 복원 전송 실패:', e.message); }
  }
}

setInterval(() => { clients.forEach(syncLiveClient); }, 5000);

function recordLiveResult(info, photoId, status) {
  if (!info.approved || !['displayed', 'image_error', 'stopped'].includes(status)) return;
  const photo = liveSessions.get(info.siteId)?.photos.find(p => p.id === photoId);
  if (!photo) return;
  if (!photo.delivery) photo.delivery = new Map();
  photo.delivery.set(info.clientId, status);
  if (status === 'displayed') info.liveSeen.add(photoId);
  else info.liveSeen.delete(photoId);
  console.log(`[Live] 표시 결과: ${photoId} / ${info.name} / ${status}`);
}

function liveDeleteFile(photo) {
  clients.forEach(info => {
    info.liveSeen?.delete(photo.id);
    info.liveAttempts?.delete(photo.id);
  });
  try {
    const p = path.join(LIVE_DIR, photo.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { console.warn('[Live] 파일 삭제 실패:', e.message); }
}

// 메시지 정제 — 40자 제한, 제어문자 제거, URL/도메인 차단(화면 광고 방지)
const LIVE_MSG_MAX = 40;
function sanitizeLiveMessage(raw) {
  let s = String(raw || '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: true, message: '' };
  if (s.length > LIVE_MSG_MAX) s = s.slice(0, LIVE_MSG_MAX);
  if (/(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|kr|io|co|me|biz|info|shop|xyz)\b)/i.test(s)) {
    return { ok: false, error: '메시지에 링크·주소는 넣을 수 없습니다.' };
  }
  return { ok: true, message: s };
}

// ─── 폰 업로드용 multer (이미지 전용) ──────────────────────
const liveStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LIVE_DIR),
  filename: (req, file, cb) => {
    let ext = (path.extname(file.originalname) || '').toLowerCase();
    if (!/^\.(jpe?g|png|gif|webp|heic|heif)$/.test(ext)) ext = '.jpg';
    cb(null, `live_${Date.now()}_${uuidv4().slice(0, 8)}${ext}`);
  }
});
const liveUpload = multer({
  storage: liveStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('이미지 파일만 올릴 수 있습니다.'));
    cb(null, true);
  }
});

function checkLiveToken(req) {
  const t = req.query.t || req.body?.t || req.headers['x-live-token'] || '';
  return !!liveConfig.token && t === liveConfig.token;
}

// ─── 폰 페이지 ─────────────────────────────────────────────
app.get(['/m', '/m.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'm.html'));
});

// ─── 폰 API (토큰 인증) ────────────────────────────────────

// 초기 정보: 송출 가능 모니터(사이트) 목록 — 폰의 '대상 모니터' 선택에 사용
app.get('/live/api/hello', (req, res) => {
  if (!checkLiveToken(req)) return res.status(401).json({ error: '링크가 유효하지 않습니다. 관리자에게 새 링크를 받아주세요.' });
  const list = sites.map(s => {
    const online = Array.from(clients.values()).some(c => c.siteId === s.id && c.ws.readyState === WebSocket.OPEN);
    return { id: s.id, name: s.name, icon: s.icon || '📺', online };
  });
  res.json({
    ok: true,
    enabled: liveConfig.enabled,
    sites: list,
    msgMax: LIVE_MSG_MAX,
    cancelSec: liveConfig.settings.cancelSec
  });
});

app.get('/live/api/delivery', (req, res) => {
  if (!checkLiveToken(req)) return res.status(401).json({ error: '링크가 유효하지 않습니다.' });
  res.set('Cache-Control', 'no-store');
  const ids = new Set(String(req.query.ids || '').split(',').slice(0, 12));
  const photos = [];
  liveSessions.forEach((session, siteId) => {
    const online = Array.from(clients.values()).filter(c => c.approved && c.siteId === siteId && c.ws.readyState === WebSocket.OPEN).length;
    session.photos.forEach(p => {
      if (!ids.has(p.id)) return;
      const results = Array.from(p.delivery?.values() || []);
      photos.push({ id: p.id, online, displayed: results.filter(s => s === 'displayed').length,
        errors: results.filter(s => s !== 'displayed') });
    });
  });
  res.json({ photos });
});

// 사진 업로드 → 지정 사이트로 즉시 송출
app.post('/live/api/photo', (req, res) => {
  liveUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '업로드 실패' });
    if (!checkLiveToken(req)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(401).json({ error: '링크가 유효하지 않습니다.' });
    }
    if (!liveConfig.enabled) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(403).json({ error: '지금은 라이브 송출이 꺼져 있습니다.' });
    }
    if (!req.file) return res.status(400).json({ error: '사진이 없습니다.' });

    const siteId = String(req.body.siteId || '');
    const site = sites.find(s => s.id === siteId);
    if (!site) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: '송출할 모니터를 다시 선택해 주세요.' });
    }

    const chk = sanitizeLiveMessage(req.body.message);
    if (!chk.ok) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: chk.error });
    }

    // 한 사람이 앨범에서 여러 장을 골라 보낸 '묶음'인지 — 화면이 순차 표출 여부를 결정한다
    let batchTotal = parseInt(req.body.batchTotal, 10);
    if (!Number.isFinite(batchTotal) || batchTotal < 1) batchTotal = 1;
    batchTotal = Math.min(batchTotal, 30);

    const photo = {
      id: uuidv4(),
      filename: req.file.filename,
      url: `/uploads/live/${req.file.filename}`,
      message: chk.message,
      batchTotal,
      uploaderId: String(req.body.uploaderId || '').slice(0, 64),
      uploaderName: String(req.body.uploaderName || '').replace(/[\x00-\x1f]/g, '').slice(0, 20),
      ts: Date.now()
    };

    const session = liveSession(siteId);
    session.photos.push(photo);
    session.lastAt = photo.ts;
    // 세션 보관량 제한 — 그리드는 최근 gridMax장만 쓰지만 여유분을 둔다
    const keepMax = Math.max(8, (liveConfig.settings.gridMax || 4) * 3);
    while (session.photos.length > keepMax) liveDeleteFile(session.photos.shift());

    liveUploadLog.unshift({
      ts: photo.ts, siteId, siteName: site.name, message: photo.message,
      uploaderName: photo.uploaderName, uploaderId: photo.uploaderId, photoId: photo.id
    });
    if (liveUploadLog.length > 50) liveUploadLog.length = 50;

    const sent = pushLive(siteId, {
      type: 'live_photo',
      photo: { id: photo.id, url: photo.url, message: photo.message, ts: photo.ts, batchTotal: photo.batchTotal },
      session: { photos: livePublicPhotos(session) },
      settings: liveConfig.settings
    });

    broadcastToAdmins({ type: 'live_update' });
    console.log(`[Live] 사진 → ${site.name}: "${photo.message || '(메시지 없음)'}" by ${photo.uploaderName || '익명'}(${photo.uploaderId.slice(0, 8)}) → ${sent}개 화면`);

    res.json({ success: true, photo: { id: photo.id, url: photo.url, message: photo.message }, screens: sent, siteName: site.name });
  });
});

// 업로더 본인 취소 (cancelSec 이내, 같은 uploaderId)
app.delete('/live/api/photo/:id', (req, res) => {
  if (!checkLiveToken(req)) return res.status(401).json({ error: '링크가 유효하지 않습니다.' });
  const uploaderId = String(req.query.uploaderId || '');
  const limitMs = (liveConfig.settings.cancelSec || 60) * 1000;

  for (const [siteId, session] of liveSessions) {
    const idx = session.photos.findIndex(p => p.id === req.params.id);
    if (idx === -1) continue;
    const photo = session.photos[idx];
    if (photo.uploaderId && uploaderId !== photo.uploaderId) return res.status(403).json({ error: '본인이 올린 사진만 취소할 수 있습니다.' });
    if (Date.now() - photo.ts > limitMs) return res.status(410).json({ error: '취소 가능 시간이 지났습니다. 관리자에게 요청해 주세요.' });

    session.photos.splice(idx, 1);
    liveDeleteFile(photo);
    pushLive(siteId, {
      type: 'live_update',
      removedId: photo.id,
      session: { photos: livePublicPhotos(session) },
      settings: liveConfig.settings
    });
    broadcastToAdmins({ type: 'live_update' });
    console.log(`[Live] 사진 취소: ${photo.id} (${photo.uploaderName || '익명'})`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: '이미 사라진 사진입니다.' });
});

// ─── 관리 API (관리자 인증) ────────────────────────────────

app.get('/api/live', (req, res) => {
  const sessions = [];
  liveSessions.forEach((session, siteId) => {
    const site = sites.find(s => s.id === siteId);
    if (!session.photos.length) return;
    sessions.push({
      siteId,
      siteName: site ? site.name : siteId,
      count: session.photos.length,
      lastAt: session.lastAt,
      photos: session.photos.slice(-6).reverse().map(p => ({
        id: p.id, url: p.url, message: p.message, uploaderName: p.uploaderName, ts: p.ts
      }))
    });
  });
  sessions.sort((a, b) => b.lastAt - a.lastAt);
  res.json({
    enabled: liveConfig.enabled,
    token: liveConfig.token,
    link: `/m?t=${liveConfig.token}`,
    settings: liveConfig.settings,
    sessions,
    log: liveUploadLog.slice(0, 20)
  });
});

app.put('/api/live', (req, res) => {
  if (req.body.enabled !== undefined) liveConfig.enabled = !!req.body.enabled;
  if (req.body.settings) {
    const s = req.body.settings;
    const num = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
    };
    const cur = liveConfig.settings;
    liveConfig.settings = {
      heroMs:      s.heroMs      !== undefined ? num(s.heroMs, 2000, 30000, cur.heroMs)        : cur.heroMs,
      heroBusyMs:  s.heroBusyMs  !== undefined ? num(s.heroBusyMs, 1500, 20000, cur.heroBusyMs) : cur.heroBusyMs,
      returnMs:    s.returnMs    !== undefined ? num(s.returnMs, 10000, 600000, cur.returnMs)   : cur.returnMs,
      cornerMs:    s.cornerMs    !== undefined ? num(s.cornerMs, 0, 900000, cur.cornerMs)       : cur.cornerMs,
      gridMax:     s.gridMax     !== undefined ? num(s.gridMax, 1, 4, cur.gridMax)              : cur.gridMax,
      photoTtlMin: s.photoTtlMin !== undefined ? num(s.photoTtlMin, 5, 1440, cur.photoTtlMin)   : cur.photoTtlMin,
      cancelSec:   s.cancelSec   !== undefined ? num(s.cancelSec, 10, 600, cur.cancelSec)       : cur.cancelSec
    };
  }
  saveLiveConfig();

  // 라이브를 끄면 진행 중인 모든 세션을 즉시 정리한다
  if (!liveConfig.enabled) liveClearAll();
  else liveSessions.forEach((session, siteId) => {
    if (session.photos.length) pushLive(siteId, { type: 'live_update', session: { photos: livePublicPhotos(session) }, settings: liveConfig.settings });
  });

  broadcastToAdmins({ type: 'live_update' });
  console.log(`[Live] 설정 변경 — 송출: ${liveConfig.enabled ? 'ON' : 'OFF'}`);
  res.json({ success: true, enabled: liveConfig.enabled, settings: liveConfig.settings });
});

// 토큰 재발급 — 기존 폰 링크는 모두 무효가 된다
app.post('/api/live/token/rotate', (req, res) => {
  liveConfig.token = newLiveToken();
  saveLiveConfig();
  broadcastToAdmins({ type: 'live_update' });
  console.log('[Live] 토큰 재발급 — 기존 링크 무효');
  res.json({ success: true, token: liveConfig.token, link: `/m?t=${liveConfig.token}` });
});

function liveClearSite(siteId) {
  const session = liveSessions.get(siteId);
  if (!session) return 0;
  const n = session.photos.length;
  session.photos.forEach(liveDeleteFile);
  session.photos = [];
  session.lastAt = 0;
  pushLive(siteId, { type: 'live_clear' });
  return n;
}

function liveClearAll() {
  let n = 0;
  liveSessions.forEach((_, siteId) => { n += liveClearSite(siteId); });
  return n;
}

// 라이브 즉시 종료 — 화면에서 내리고 사진 파일까지 삭제 (사고 대응용)
app.post('/api/live/clear', (req, res) => {
  const siteId = req.body && req.body.siteId;
  const n = siteId ? liveClearSite(siteId) : liveClearAll();
  broadcastToAdmins({ type: 'live_update' });
  console.log(`[Live] 즉시 종료${siteId ? ` (${siteId})` : ' (전체)'} — 사진 ${n}장 삭제`);
  res.json({ success: true, removed: n });
});

// 관리자가 개별 사진 삭제
app.delete('/api/live/photo/:id', (req, res) => {
  for (const [siteId, session] of liveSessions) {
    const idx = session.photos.findIndex(p => p.id === req.params.id);
    if (idx === -1) continue;
    const [photo] = session.photos.splice(idx, 1);
    liveDeleteFile(photo);
    pushLive(siteId, { type: 'live_update', removedId: photo.id, session: { photos: livePublicPhotos(session) }, settings: liveConfig.settings });
    broadcastToAdmins({ type: 'live_update' });
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Not found' });
});

// ─── TTL 정리 (사진은 휘발성 — 콘텐츠 라이브러리에 남기지 않는다) ───
setInterval(() => {
  const ttl = (liveConfig.settings.photoTtlMin || 180) * 60 * 1000;
  const cutoff = Date.now() - ttl;
  const keep = new Set();
  liveSessions.forEach((session, siteId) => {
    const before = session.photos.length;
    const expired = session.photos.filter(p => p.ts < cutoff);
    if (expired.length) {
      session.photos = session.photos.filter(p => p.ts >= cutoff);
      expired.forEach(liveDeleteFile);
      if (session.photos.length) {
        pushLive(siteId, { type: 'live_update', session: { photos: livePublicPhotos(session) }, settings: liveConfig.settings });
      } else {
        pushLive(siteId, { type: 'live_clear' });
      }
      console.log(`[Live] TTL 정리: ${siteId} — ${before - session.photos.length}장 삭제`);
      broadcastToAdmins({ type: 'live_update' });
    }
    session.photos.forEach(p => keep.add(p.filename));
  });
  // 세션에 없는 고아 파일 정리 (재시작 등으로 남은 것)
  try {
    for (const f of fs.readdirSync(LIVE_DIR)) {
      if (keep.has(f)) continue;
      const fp = path.join(LIVE_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); console.log(`[Live] 고아 파일 삭제: ${f}`); }
      } catch (e) {}
    }
  } catch (e) {}
}, 5 * 60 * 1000);

// ─── WebSocket ──────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] 새 연결 수립');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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
          ws, clientId, name: clientName, monitors, siteId: assignedSiteId,
          liveReady: false, liveSeen: new Set(), liveAttempts: new Map(),
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
        } else {
          // 미승인(초기화된 경우 포함)이면 대기 화면으로 되돌린다.
          // (로컬 config에 approved=true가 남아 재생 중이던 클라이언트도 확실히 리셋)
          ws.send(JSON.stringify({ type: 'rejected' }));
        }

        broadcastToAdmins({ type: 'client_update' });
      }

      if (msg.type === 'live_ready' || msg.type === 'live_result') {
        // 결과는 clientId 자기신고가 아닌, 이 소켓에 등록된 화면에 연결한다.
        const info = Array.from(clients.values()).find(c => c.ws === ws);
        if (info && info.approved) {
          if (msg.type === 'live_ready') {
            info.liveReady = true;
            info.liveSeen = new Set();
            info.liveAttempts.clear();
            for (const id of (Array.isArray(msg.seen) ? msg.seen.slice(-100) : [])) recordLiveResult(info, id, 'displayed');
            syncLiveClient(info);
          } else {
            recordLiveResult(info, msg.photoId, msg.status);
          }
        }
      }

      if (msg.type === 'heartbeat') {
        const client = clients.get(msg.clientId);
        if (client) {
          client.lastSeen = new Date().toISOString();
          client.scheduleVersion = msg.scheduleVersion || 0;
          if (msg.currentPlaying !== undefined) {
            const changed = JSON.stringify(client.currentPlaying) !== JSON.stringify(msg.currentPlaying);
            client.currentPlaying = msg.currentPlaying;
            // 재생 콘텐츠가 바뀌면 관리자 대시보드가 즉시 갱신되도록 알림
            if (changed) broadcastToAdmins({ type: 'client_update' });
          }
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
// Wi-Fi 단절 등 close 이벤트가 늦는 연결도 정리해 클라이언트 재접속을 유도한다.
setInterval(() => {
  wss.clients.forEach(socket => {
    if (!socket.isAlive) { socket.terminate(); return; }
    socket.isAlive = false;
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  });
}, 30000);

function broadcastToAdmins(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client._isAdmin && client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function getSiteSchedule(siteId) {
  const now = new Date();
  const rawEntries = scheduleData.entries.filter(e => {
    if (e.siteId !== siteId) return false;
    if (!e.enabled) return false;
    if (e.validFrom && new Date(e.validFrom) > now) return false;
    if (e.validTo && new Date(e.validTo) < now) return false;
    return true;
  });

  // 클라이언트 플레이어가 이해할 수 있는 형식으로 변환
  // 호스트 편성표: file1, file2, file1Mime, file2Mime, layoutType, duration, audio, transition
  // 클라이언트 기대: entries[].{ url, filename, mimeType, duration, sound, active }
  // 각 편성 항목은 file1(좌)+file2(우)를 쌍으로 유지한다.
  // 실제 표출 방식(동시/순차/분할)은 클라이언트가 모니터 수와 layoutType으로 결정:
  //  - 모니터 2대: file1 → 좌 화면, file2 → 우 화면 동시 표출
  //  - 모니터 1대 + 독립(independent): file1 → file2 순차 표출
  //  - 모니터 1대 + 분할(split): 한 화면에 좌/우 나란히
  const entries = [];
  for (const e of rawEntries) {
    if (!e.file1 && !e.file2) continue;
    const primary = e.file1 || e.file2;
    const primaryMime = (e.file1 ? e.file1Mime : e.file2Mime) || 'image/jpeg';
    const secondary = (e.file1 && e.file2) ? e.file2 : '';
    entries.push({
      filename: primary,
      url: `/uploads/${primary}`,
      mimeType: primaryMime,
      filename2: secondary || '',
      url2: secondary ? `/uploads/${secondary}` : '',
      mimeType2: e.file2Mime || 'image/jpeg',
      duration: e.duration || 10,
      videoDuration: e.videoDuration || 'original',
      sound: e.audio || 'none',
      transition: e.transition || 'fade',
      layoutType: e.layoutType || 'independent',
      active: true
    });
  }
  return { version: scheduleData.version, entries };
}

function pushScheduleToAllClients() {
  let count = 0;
  clients.forEach((info) => {
    if (info.ws.readyState === WebSocket.OPEN && info.approved) {
      const schedule = info.siteId ? getSiteSchedule(info.siteId) : { version: scheduleData.version, entries: [] };
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
