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

// 클라이언트 앱 원격 종료 (호스트에서 클라이언트 PC의 플레이어를 끔)
app.post('/api/clients/:id/quit', (req, res) => {
  const client = clients.get(req.params.id);
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: '클라이언트가 오프라인입니다.' });
  }
  client.ws.send(JSON.stringify({ type: 'quit' }));
  console.log(`[Clients] 원격 종료 명령: ${client.name} (${req.params.id})`);
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
        } else {
          // 미승인(초기화된 경우 포함)이면 대기 화면으로 되돌린다.
          // (로컬 config에 approved=true가 남아 재생 중이던 클라이언트도 확실히 리셋)
          ws.send(JSON.stringify({ type: 'rejected' }));
        }

        broadcastToAdmins({ type: 'client_update' });
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
