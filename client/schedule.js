/**
 * 편성표(큐시트) 관리 모듈
 * - 편성표 데이터 모델 정의
 * - 로컬 JSON 파일로 저장/로드
 * - 호스트에서 수신한 편성표 적용
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * 편성표 항목(Entry) 데이터 모델:
 * {
 *   id: string,              // 고유 ID
 *   order: number,           // 표출 순서
 *   file1: string,           // 좌측(또는 단일) 파일명 (드라이브 파일명)
 *   file2: string | null,    // 우측 파일명 (듀얼 모니터용, 없으면 null)
 *   duration: number,        // 표출 시간 (초)
 *   videoDuration: 'original' | 'custom',  // 동영상: 원본길이 or 설정시간
 *   transition: 'cut' | 'fade',            // 전환 효과
 *   enabled: boolean         // 활성화 여부
 * }
 */

class ScheduleManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || path.join(__dirname, 'cache');
    this.schedulePath = path.join(this.dataDir, 'schedule.json');
    this.entries = [];
    this.version = 0; // 편성표 버전 (호스트와 동기화용)
  }

  /**
   * 초기화 — 로컬 편성표 로드
   */
  initialize() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.load();
    console.log(`[Schedule] 초기화 완료: ${this.entries.length}개 항목, 버전 ${this.version}`);
  }

  /**
   * 로컬 파일에서 편성표 로드
   */
  load() {
    try {
      if (fs.existsSync(this.schedulePath)) {
        const data = JSON.parse(fs.readFileSync(this.schedulePath, 'utf8'));
        this.entries = data.entries || [];
        this.version = data.version || 0;
      }
    } catch (e) {
      console.warn('[Schedule] 로드 실패, 빈 편성표로 시작:', e.message);
      this.entries = [];
      this.version = 0;
    }
  }

  /**
   * 로컬 파일에 편성표 저장
   */
  save() {
    try {
      const data = {
        version: this.version,
        updatedAt: new Date().toISOString(),
        entries: this.entries
      };
      fs.writeFileSync(this.schedulePath, JSON.stringify(data, null, 2));
      console.log(`[Schedule] 저장 완료: ${this.entries.length}개 항목`);
    } catch (e) {
      console.error('[Schedule] 저장 실패:', e.message);
    }
  }

  /**
   * 호스트에서 수신한 편성표로 업데이트
   */
  applyFromHost(scheduleData) {
    const newVersion = scheduleData.version || 0;

    // 버전이 같거나 낮으면 무시
    if (newVersion <= this.version && this.entries.length > 0) {
      console.log(`[Schedule] 수신 버전(${newVersion}) <= 현재(${this.version}), 무시`);
      return false;
    }

    this.entries = scheduleData.entries || [];
    this.version = newVersion;
    this.save();

    console.log(`[Schedule] 호스트에서 편성표 수신: 버전 ${this.version}, ${this.entries.length}개 항목`);
    this.emit('updated', this.entries);
    return true;
  }

  /**
   * 활성화된 항목만 순서대로 반환
   */
  getActiveEntries() {
    return this.entries
      .filter(e => e.enabled !== false)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * 편성표가 비어있는지 확인
   */
  isEmpty() {
    return this.getActiveEntries().length === 0;
  }

  /**
   * 편성표 버전 반환
   */
  getVersion() {
    return this.version;
  }

  /**
   * 전체 편성표 데이터 반환 (호스트 전송용)
   */
  toJSON() {
    return {
      version: this.version,
      entries: this.entries
    };
  }
}

module.exports = ScheduleManager;
