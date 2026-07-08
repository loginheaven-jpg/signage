/**
 * 클라이언트용 구글 드라이브 동기화 모듈
 * - 서비스 계정으로 직접 인증
 * - 지정 폴더의 파일을 로컬 캐시에 동기화
 * - 5분 주기 자동 체크 + 호스트 푸시로 즉시 동기화
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ClientGDriveSync extends EventEmitter {
  constructor(options = {}) {
    super();
    this.credentialsPath = options.credentialsPath || path.join(__dirname, 'credentials', 'service-account.json');
    this.folderId = options.folderId || '1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm';
    this.cacheDir = options.cacheDir || path.join(__dirname, 'cache', 'media');
    this.syncInterval = options.syncInterval || 5 * 60 * 1000; // 5분
    this.drive = null;
    this.timer = null;
    this.lastSync = null;
    this.syncInProgress = false;

    // 동기화 상태 추적
    this.syncedFiles = new Map(); // driveFileId -> { name, localPath, mimeType, modifiedTime, size }
  }

  /**
   * 인증 및 드라이브 클라이언트 초기화
   */
  async initialize() {
    try {
      if (!fs.existsSync(this.credentialsPath)) {
        console.error('[GDrive] 서비스 계정 키 파일 없음:', this.credentialsPath);
        return false;
      }

      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
      });

      this.drive = google.drive({ version: 'v3', auth });

      // 캐시 디렉토리 생성
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      // 기존 동기화 상태 로드
      this.loadSyncState();

      console.log('[GDrive] 클라이언트 동기화 모듈 초기화 완료');
      console.log(`[GDrive] 폴더 ID: ${this.folderId}`);
      console.log(`[GDrive] 캐시 경로: ${this.cacheDir}`);

      return true;
    } catch (err) {
      console.error('[GDrive] 초기화 실패:', err.message);
      return false;
    }
  }

  /**
   * 동기화 상태 파일 경로
   */
  get statePath() {
    return path.join(this.cacheDir, '..', '.sync-state.json');
  }

  /**
   * 동기화 상태 로드
   */
  loadSyncState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        this.syncedFiles = new Map(Object.entries(data.files || {}));
        this.lastSync = data.lastSync ? new Date(data.lastSync) : null;
        console.log(`[GDrive] 캐시 상태 로드: ${this.syncedFiles.size}개 파일`);
      }
    } catch (e) {
      console.warn('[GDrive] 상태 로드 실패, 초기화합니다.');
      this.syncedFiles = new Map();
    }
  }

  /**
   * 동기화 상태 저장
   */
  saveSyncState() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        lastSync: new Date().toISOString(),
        files: Object.fromEntries(this.syncedFiles)
      };
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[GDrive] 상태 저장 실패:', e.message);
    }
  }

  /**
   * 드라이브 폴더의 파일 목록 조회
   */
  async listFiles() {
    const supportedMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
      'video/mp4', 'video/webm', 'video/avi', 'video/quicktime', 'video/x-msvideo'
    ];

    const query = `'${this.folderId}' in parents and trashed = false and (${
      supportedMimes.map(m => `mimeType = '${m}'`).join(' or ')
    })`;

    try {
      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, mimeType, modifiedTime, size)',
        orderBy: 'name',
        pageSize: 1000
      });

      return response.data.files || [];
    } catch (err) {
      console.error('[GDrive] 파일 목록 조회 실패:', err.message);
      return null; // null = 네트워크 오류 (기존 캐시 유지)
    }
  }

  /**
   * 파일 다운로드
   */
  async downloadFile(fileId, fileName) {
    // 안전한 파일명 생성
    const safeName = `${fileId}_${fileName.replace(/[^a-zA-Z0-9가-힣._-]/g, '_')}`;
    const destPath = path.join(this.cacheDir, safeName);

    try {
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      const writer = fs.createWriteStream(destPath);

      return new Promise((resolve, reject) => {
        response.data
          .on('end', () => {
            console.log(`[GDrive] ✓ 다운로드: ${fileName}`);
            resolve(destPath);
          })
          .on('error', (err) => {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
          })
          .pipe(writer);
      });
    } catch (err) {
      console.error(`[GDrive] 다운로드 실패 (${fileName}):`, err.message);
      throw err;
    }
  }

  /**
   * 전체 동기화 수행
   */
  async sync() {
    if (this.syncInProgress) {
      console.log('[GDrive] 동기화 진행 중, 건너뜀');
      return false;
    }

    this.syncInProgress = true;
    console.log('[GDrive] 동기화 시작...');

    try {
      const driveFiles = await this.listFiles();

      // 네트워크 오류 시 기존 캐시 유지
      if (driveFiles === null) {
        console.warn('[GDrive] 네트워크 오류 — 기존 캐시로 계속 재생');
        this.syncInProgress = false;
        return false;
      }

      console.log(`[GDrive] 드라이브 파일 ${driveFiles.length}개 발견`);

      const driveFileIds = new Set(driveFiles.map(f => f.id));
      let downloaded = 0;
      let deleted = 0;
      let changed = false;

      // 1. 새 파일 또는 수정된 파일 다운로드
      for (const file of driveFiles) {
        const existing = this.syncedFiles.get(file.id);

        if (!existing || existing.modifiedTime !== file.modifiedTime) {
          // 기존 파일이 수정된 경우 삭제 후 재다운로드
          if (existing && fs.existsSync(existing.localPath)) {
            fs.unlinkSync(existing.localPath);
          }

          try {
            const localPath = await this.downloadFile(file.id, file.name);
            this.syncedFiles.set(file.id, {
              name: file.name,
              localPath,
              mimeType: file.mimeType,
              modifiedTime: file.modifiedTime,
              size: parseInt(file.size) || 0
            });
            downloaded++;
            changed = true;
          } catch (err) {
            console.error(`[GDrive] ${file.name} 동기화 실패:`, err.message);
          }
        }
      }

      // 2. 드라이브에서 삭제된 파일 로컬에서도 제거
      for (const [fileId, fileInfo] of this.syncedFiles) {
        if (!driveFileIds.has(fileId)) {
          if (fs.existsSync(fileInfo.localPath)) {
            fs.unlinkSync(fileInfo.localPath);
            console.log(`[GDrive] ✗ 삭제: ${fileInfo.name}`);
          }
          this.syncedFiles.delete(fileId);
          deleted++;
          changed = true;
        }
      }

      // 3. 상태 저장
      this.saveSyncState();
      this.lastSync = new Date();

      console.log(`[GDrive] 동기화 완료 — 다운로드: ${downloaded}, 삭제: ${deleted}, 전체: ${this.syncedFiles.size}개`);

      // 변경이 있으면 이벤트 발생
      if (changed) {
        this.emit('files-changed', this.getFileList());
      }

      return changed;
    } catch (err) {
      console.error('[GDrive] 동기화 오류:', err.message);
      return false;
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * 현재 캐시된 파일 목록 반환
   */
  getFileList() {
    const files = [];
    for (const [fileId, info] of this.syncedFiles) {
      if (fs.existsSync(info.localPath)) {
        files.push({
          id: fileId,
          name: info.name,
          localPath: info.localPath,
          mimeType: info.mimeType,
          size: info.size
        });
      }
    }
    // 파일명 기준 정렬
    files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return files;
  }

  /**
   * 주기적 동기화 시작
   */
  startAutoSync() {
    // 즉시 1회 실행
    this.sync();

    // 주기적 실행
    this.timer = setInterval(() => this.sync(), this.syncInterval);
    console.log(`[GDrive] 자동 동기화 시작 (간격: ${this.syncInterval / 1000}초)`);
  }

  /**
   * 자동 동기화 중지
   */
  stopAutoSync() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 상태 정보 반환
   */
  getStatus() {
    return {
      initialized: !!this.drive,
      folderId: this.folderId,
      lastSync: this.lastSync ? this.lastSync.toISOString() : null,
      fileCount: this.syncedFiles.size,
      syncInProgress: this.syncInProgress
    };
  }
}

module.exports = ClientGDriveSync;
