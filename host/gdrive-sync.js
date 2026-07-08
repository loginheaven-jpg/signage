/**
 * 구글 드라이브 동기화 모듈
 * - 서비스 계정으로 인증
 * - 지정 폴더의 파일 목록 조회
 * - 로컬에 없는 파일 다운로드
 * - 드라이브에서 삭제된 파일 로컬에서도 제거
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GDriveSync {
  constructor(options = {}) {
    this.credentialsPath = options.credentialsPath || path.join(__dirname, 'credentials', 'service-account.json');
    this.folderId = options.folderId || '1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm';
    this.downloadDir = options.downloadDir || path.join(__dirname, 'uploads');
    this.syncInterval = options.syncInterval || 5 * 60 * 1000; // 5분
    this.drive = null;
    this.timer = null;
    this.lastSync = null;
    this.syncInProgress = false;
    this.onSyncComplete = options.onSyncComplete || null;

    // 동기화 상태 추적
    this.syncedFiles = new Map(); // driveFileId -> { name, localPath, mimeType, modifiedTime }
  }

  /**
   * 인증 및 드라이브 클라이언트 초기화
   * - 환경변수 GOOGLE_SERVICE_ACCOUNT_KEY가 있으면 우선 사용 (Railway 등 클라우드 배포용)
   * - 없으면 로컬 파일(credentials/service-account.json)에서 읽기
   */
  async initialize() {
    try {
      let credentials;

      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        // 환경변수에서 서비스 계정 키 읽기 (Railway, Render 등)
        credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        console.log('[GDrive] 환경변수에서 서비스 계정 키 로드');
      } else if (fs.existsSync(this.credentialsPath)) {
        // 로컬 파일에서 읽기
        credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
        console.log('[GDrive] 로컬 파일에서 서비스 계정 키 로드');
      } else {
        throw new Error('서비스 계정 키를 찾을 수 없습니다. GOOGLE_SERVICE_ACCOUNT_KEY 환경변수 또는 credentials/service-account.json 파일이 필요합니다.');
      }

      // 환경변수 GDRIVE_FOLDER_ID가 있으면 덮어쓰기
      if (process.env.GDRIVE_FOLDER_ID) {
        this.folderId = process.env.GDRIVE_FOLDER_ID;
      }

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
      });

      this.drive = google.drive({ version: 'v3', auth });
      
      // 다운로드 디렉토리 확인
      if (!fs.existsSync(this.downloadDir)) {
        fs.mkdirSync(this.downloadDir, { recursive: true });
      }

      // 기존 동기화 상태 로드
      this.loadSyncState();

      console.log('[GDrive] 초기화 완료');
      console.log(`[GDrive] 폴더 ID: ${this.folderId}`);
      console.log(`[GDrive] 다운로드 경로: ${this.downloadDir}`);
      
      return true;
    } catch (err) {
      console.error('[GDrive] 초기화 실패:', err.message);
      return false;
    }
  }

  /**
   * 동기화 상태 파일 로드
   */
  loadSyncState() {
    const statePath = path.join(this.downloadDir, '.sync-state.json');
    try {
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        this.syncedFiles = new Map(Object.entries(data.files || {}));
        this.lastSync = data.lastSync ? new Date(data.lastSync) : null;
      }
    } catch (e) {
      console.warn('[GDrive] 동기화 상태 로드 실패, 초기화합니다.');
      this.syncedFiles = new Map();
    }
  }

  /**
   * 동기화 상태 파일 저장
   */
  saveSyncState() {
    const statePath = path.join(this.downloadDir, '.sync-state.json');
    const data = {
      lastSync: new Date().toISOString(),
      files: Object.fromEntries(this.syncedFiles)
    };
    fs.writeFileSync(statePath, JSON.stringify(data, null, 2));
  }

  /**
   * 드라이브 폴더의 파일 목록 조회
   */
  async listFiles() {
    const supportedMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/avi', 'video/quicktime'
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
      return [];
    }
  }

  /**
   * 파일 다운로드
   */
  async downloadFile(fileId, fileName) {
    const destPath = path.join(this.downloadDir, `gdrive_${fileId}_${fileName}`);
    
    try {
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      const writer = fs.createWriteStream(destPath);
      
      return new Promise((resolve, reject) => {
        response.data
          .on('end', () => {
            console.log(`[GDrive] ✓ 다운로드 완료: ${fileName}`);
            resolve(destPath);
          })
          .on('error', (err) => {
            fs.unlinkSync(destPath);
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
      return;
    }

    this.syncInProgress = true;
    console.log('[GDrive] 동기화 시작...');

    try {
      const driveFiles = await this.listFiles();
      console.log(`[GDrive] 드라이브 파일 ${driveFiles.length}개 발견`);

      const driveFileIds = new Set(driveFiles.map(f => f.id));
      let downloaded = 0;
      let deleted = 0;

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
              size: file.size
            });
            downloaded++;
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
        }
      }

      // 3. 상태 저장
      this.saveSyncState();
      this.lastSync = new Date();

      console.log(`[GDrive] 동기화 완료 — 다운로드: ${downloaded}, 삭제: ${deleted}, 전체: ${this.syncedFiles.size}개`);

      // 콜백 호출
      if (this.onSyncComplete) {
        this.onSyncComplete(this.getFileList());
      }

    } catch (err) {
      console.error('[GDrive] 동기화 오류:', err.message);
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * 현재 동기화된 파일 목록 반환 (호스트 서버에서 사용)
   */
  getFileList() {
    const files = [];
    for (const [fileId, info] of this.syncedFiles) {
      if (fs.existsSync(info.localPath)) {
        const filename = path.basename(info.localPath);
        files.push({
          driveId: fileId,
          filename,
          originalName: info.name,
          mimeType: info.mimeType,
          url: `/uploads/${filename}`,
          source: 'gdrive',
          modifiedTime: info.modifiedTime
        });
      }
    }
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
      console.log('[GDrive] 자동 동기화 중지');
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
      syncInProgress: this.syncInProgress,
      autoSync: !!this.timer
    };
  }
}

module.exports = GDriveSync;
