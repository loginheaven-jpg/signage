# 디지털 게시판 시스템 아키텍처 문서

> **저장소**: `loginheaven-jpg/signage`  
> **배포 URL**: https://signage.yebom.org  
> **플랫폼**: Railway (호스트 서버), Windows PC (클라이언트)  
> **최종 업데이트**: 2026-07-08

---

## 1. 시스템 개요

교회 내 여러 장소(현관, 식당, 가람방 등)에 설치된 모니터에 이미지/영상 콘텐츠를 원격으로 편성·배포하는 디지털 사이니지 시스템이다. 호스트 서버에서 편성표를 관리하고, 각 클라이언트 PC가 WebSocket으로 실시간 수신하여 전체화면으로 재생한다.

### 핵심 특징

- **다중 사이트**: 장소별 독립 편성표 운영 (가람방, 식당 등)
- **실시간 푸시**: 편성표 변경 즉시 해당 사이트 클라이언트에 전송
- **원클릭 설치**: 클라이언트 PC에 zip 해제 후 install.bat 실행으로 완료
- **승인 기반 등록**: 클라이언트가 호스트에 접속하면 대기 → 관리자 승인 → 재생 시작
- **구글 드라이브 연동**: 지정 폴더의 콘텐츠 자동 동기화

---

## 2. 저장소 구조

```
signage/
├── architecture.md          ← 이 문서
├── README.md
├── host/                    ← 호스트 서버 (Railway 배포)
│   ├── server.js            ← Express + WebSocket 서버 (v3)
│   ├── gdrive-sync.js       ← 구글 드라이브 동기화 모듈
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── public/
│   │   ├── index.html       ← 호스트 관리 UI (SPA)
│   │   └── player.html      ← 웹 브라우저 테스트 플레이어
│   └── data/
│       ├── sites.json       ← 사이트 목록 (동적 생성)
│       ├── schedule.json    ← 편성표 데이터
│       ├── content.json     ← 로컬 업로드 콘텐츠 목록 (영속화)
│       └── approved-clients.json  ← 승인된 클라이언트 목록
│
└── client/                  ← Electron 클라이언트 (Windows PC)
    ├── main.js              ← Electron 메인 프로세스 (WS + 로컬 캐시 + 듀얼모니터)
    ├── preload.js           ← IPC 브릿지
    ├── setup.html           ← 최초 설정 화면
    ├── waiting.html         ← 승인 대기 화면
    ├── player.html          ← 전체화면 플레이어 (분할/보조화면 지원)
    ├── package.json
    ├── cache/               ← 오프라인 재생용 로컬 캐시 (자동 생성)
    │   ├── schedule.json    ←   마지막 수신 편성표
    │   └── media/           ←   다운로드된 이미지/영상
    ├── install.bat          ← 원클릭 설치 (의존성 + 자동시작 등록)
    ├── start.bat            ← 실행 스크립트 (부팅 시 자동시작용)
    └── uninstall.bat        ← 자동시작 해제
```

---

## 3. 호스트 서버 (host/)

### 3.1 기술 스택

| 항목 | 기술 |
|------|------|
| 런타임 | Node.js |
| 웹 프레임워크 | Express 4 |
| 실시간 통신 | WebSocket (ws 라이브러리) |
| 파일 업로드 | Multer |
| 클라우드 스토리지 | Google Drive API (googleapis) |
| 배포 | Railway (GitHub 자동 배포) |
| 도메인 | signage.yebom.org (CNAME → Railway) |

### 3.2 서버 설정

| 환경변수 | 용도 | 기본값 |
|----------|------|--------|
| `PORT` | 서버 포트 | 3000 (Railway는 자동 할당) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 서비스 계정 JSON 전체 | 없음 (로컬 파일 폴백) |
| `GDRIVE_FOLDER_ID` | 동기화 대상 드라이브 폴더 ID | `1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm` |
| `ADMIN_PASSWORD` | 관리 UI/API HTTP Basic 인증 비밀번호 | 없음 (설정 시 인증 활성) |
| `ADMIN_USER` | 관리자 사용자명 | `admin` |

> `ADMIN_PASSWORD`가 설정되면 관리 UI(`/`)와 모든 `/api` 호출에 인증이 요구된다. 클라이언트가 사용하는 `/uploads`, `/player.html`, WebSocket은 인증 대상이 아니다. 미설정 시 인증 없이 동작한다.

### 3.3 REST API 목록

#### 사이트 관리

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/sites` | 사이트 목록 (클라이언트 상태 포함) |
| POST | `/api/sites` | 사이트 추가 `{ name, icon, monitors, description }` |
| DELETE | `/api/sites/:id` | 사이트 삭제 (편성표도 함께 삭제) |

#### 클라이언트 관리

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/clients` | 연결된 클라이언트 목록 |
| POST | `/api/clients/:id/approve` | 클라이언트 승인 `{ siteId }` (미지정 시 같은 이름 사이트 재사용, 없으면 자동 생성) |
| POST | `/api/clients/:id/reject` | 클라이언트 거부/삭제 |
| POST | `/api/clients/:id/quit` | 클라이언트 앱 원격 종료 (온라인 클라이언트만) |
| PUT | `/api/clients/:id/site` | 클라이언트 사이트 재배정 `{ siteId }` |

#### 편성표 (큐시트)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/schedule` | 전체 편성표 조회 |
| GET | `/api/schedule/:siteId` | 사이트별 편성표 (클라이언트 형식으로 변환) |
| PUT | `/api/schedule` | 편성표 저장 `{ entries: [...] }` → 자동 푸시 |
| POST | `/api/schedule/apply` | 전체 클라이언트에 편성표 재전송 |
| POST | `/api/schedule/:siteId/apply` | 특정 사이트 클라이언트에만 전송 |

#### 콘텐츠

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/content` | 콘텐츠 파일 목록 (로컬 + 드라이브) |
| POST | `/api/upload` | 파일 업로드 (multipart, 최대 500MB) |
| DELETE | `/api/content/:id` | 콘텐츠 삭제 |

#### 재생 제어

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/play` | 특정 클라이언트에 즉시 재생 명령 `{ clientId, files }` |
| POST | `/api/stop` | 특정 클라이언트 재생 중지 `{ clientId }` |

#### 구글 드라이브

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/gdrive/status` | 동기화 상태 조회 |
| POST | `/api/gdrive/sync` | 수동 동기화 실행 |

### 3.4 WebSocket 프로토콜

서버 주소: `wss://signage.yebom.org` (HTTP Upgrade)

#### 클라이언트 → 서버

```json
{ "type": "register", "clientId": "uuid", "name": "가람방", "monitors": 1 }
{ "type": "heartbeat", "clientId": "uuid", "scheduleVersion": 1720000000000 }
{ "type": "admin_subscribe" }
```

#### 서버 → 클라이언트

```json
{ "type": "approved", "siteId": "site_abc12345" }
{ "type": "rejected" }
{ "type": "pending" }
{ "type": "schedule_update", "schedule": { "version": 1720000000000, "entries": [...] } }
{ "type": "play", "files": [...] }
{ "type": "stop" }
{ "type": "quit" }
{ "type": "sync_now" }
```

#### 서버 → 관리 UI (admin)

```json
{ "type": "client_update" }
{ "type": "sites_update" }
{ "type": "schedule_update", "schedule": {...} }
```

### 3.5 데이터 스키마

#### sites.json

```json
[
  {
    "id": "site_abc12345",
    "name": "가람방",
    "icon": "📺",
    "monitors": 1,
    "description": "가람방 클라이언트 자동 생성"
  }
]
```

#### schedule.json

```json
{
  "version": 1720000000000,
  "entries": [
    {
      "siteId": "site_abc12345",
      "file1": "gdrive_xxxxx_filename.jpg",
      "file2": "gdrive_yyyyy_filename.jpg",
      "file1Mime": "image/jpeg",
      "file2Mime": "image/jpeg",
      "duration": 10,
      "videoDuration": "original",
      "layoutType": "independent",
      "audio": "none",
      "transition": "fade",
      "validFrom": null,
      "validTo": null,
      "enabled": true
    }
  ]
}
```

#### approved-clients.json

```json
{
  "uuid-string": {
    "name": "가람방",
    "siteId": "site_abc12345",
    "approvedAt": "2026-07-08T06:40:00.000Z"
  }
}
```

### 3.6 편성표 데이터 변환

호스트 편성표(관리자 편집용)와 클라이언트 플레이어가 기대하는 형식이 다르므로, `getSiteSchedule()` 함수에서 변환한다:

| 호스트 편성표 (schedule.json) | 클라이언트 수신 형식 |
|-------------------------------|---------------------|
| `file1`, `file2`, `file1Mime`, `file2Mime` | `url`, `filename`, `mimeType` |
| `audio` | `sound` |
| `enabled` | `active` |
| 독립 모드: file1+file2 → 2개 항목 | 각각 별도 재생 항목으로 분리 |
| 분할 모드: file1+file2 → 1개 항목 | `url`/`mimeType`(좌) + `url2`/`mimeType2`(우) 동시 표출 |

### 3.7 구글 드라이브 동기화

- **모듈**: `gdrive-sync.js`
- **인증**: 환경변수 `GOOGLE_SERVICE_ACCOUNT_KEY` 우선, 없으면 `credentials/service-account.json` 파일
- **동작**: 지정 폴더의 파일을 3분 간격으로 자동 동기화
- **파일명 규칙**: `gdrive_{driveFileId}_{originalName}` 형태로 로컬 저장
- **양방향 삭제**: 드라이브에서 삭제된 파일은 로컬에서도 제거

---

## 4. 클라이언트 (client/)

### 4.1 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron |
| 통신 | WebSocket (ws) |
| 설정 저장 | 로컬 config.json |
| 자동시작 | Windows 시작프로그램 폴더 바로가기 |

### 4.2 설치 및 배포 프로세스

```
1. 새 PC에 Node.js LTS 설치 (https://nodejs.org)
2. signage-client.zip 압축 해제 (예: C:\signage-client\)
3. install.bat 더블클릭
   → npm install --production (electron, ws 설치)
   → 시작프로그램에 start.bat 바로가기 생성
   → 클라이언트 앱 실행
4. 설정 화면에서 이름 입력, 서버 주소 확인, 저장
5. 호스트 관리 화면에서 승인
6. 전체화면 플레이어 자동 시작
```

### 4.3 클라이언트 상태 머신

```
┌──────────┐    설정 저장     ┌──────────┐    호스트 승인    ┌──────────┐
│  설정    │ ──────────────→ │  대기    │ ──────────────→ │  재생    │
│ (setup)  │                 │(waiting) │                 │(player)  │
└──────────┘                 └──────────┘                 └──────────┘
     ↑                            ↑                            │
     │         Ctrl+Shift+S       │         거부/연결끊김       │
     └────────────────────────────┴────────────────────────────┘
```

### 4.4 config.json

```json
{
  "clientName": "가람방",
  "hostUrl": "https://signage.yebom.org",
  "monitors": 1,
  "clientId": "uuid-auto-generated",
  "approved": true,
  "siteId": "site_abc12345"
}
```

### 4.5 단축키

| 키 | 기능 |
|----|------|
| Ctrl+Shift+P | 일시정지/재개 토글 |
| Ctrl+Shift+Q | 종료 (확인창) |
| Ctrl+Shift+S | 설정 화면 재표시 |
| Ctrl+Shift+F | 전체화면 토글 |
| ESC | 전체화면 해제 |

> 단축키는 시스템 전역(`globalShortcut`)으로 등록되므로 다른 앱과 충돌을 피하기 위해 모두 `Ctrl+Shift+…` 조합을 사용한다(단독 `Ctrl+P`/`Ctrl+X`는 전역에서 인쇄/잘라내기를 가로채므로 사용하지 않음). 마우스를 움직이면 화면 하단에 일시정지·설정·종료 컨트롤 바가 나타난다(3초 후 자동 숨김). 종료는 오조작 방지를 위해 확인창을 거친다.

### 4.6 자동 재연결

- WebSocket 연결 끊김 시 5초 간격으로 자동 재연결
- 이미 승인된 클라이언트(`approved-clients.json`에 기록)는 재접속 시 자동 승인
- 30초 간격 heartbeat 전송

### 4.7 오프라인/독립 재생 (로컬 캐시)

Electron 메인 프로세스가 편성표와 미디어를 로컬에 캐시하여, 호스트가 꺼져 있거나 인터넷이 끊겨도 마지막 편성표로 계속 재생한다.

- **편성표 캐시**: `schedule_update` 수신 시 원본 편성표를 `cache/schedule.json`에 저장. 앱 시작 시 이 캐시를 로드하여 호스트 연결 전에도 즉시 재생 시작.
- **미디어 캐시**: 편성표가 참조하는 이미지/영상을 `cache/media/`에 백그라운드 다운로드. 다운로드 완료 즉시 렌더러에 `file://` 로컬 경로로 재전송하여 로컬 재생으로 전환. 캐시에 없는 항목은 임시로 호스트에서 스트리밍한다.
- **캐시 정리**: 현재 편성표에 없는 미디어 파일은 자동 삭제.

### 4.8 듀얼 모니터

- `config.monitors >= 2` 이고 물리 디스플레이가 2개 이상이면, 보조(우측) 디스플레이에 전체화면 보조 창을 생성.
- 분할(split) 편성 항목의 좌측(file1)은 주 창, 우측(file2)은 보조 창으로 전송(IPC `screen2-media`).
- 물리 디스플레이가 1개이거나 분할 항목이면, 주 창 안에서 좌/우를 나란히(side-by-side) 렌더링.

---

## 5. 호스트 관리 UI (host/public/index.html)

SPA(Single Page Application) 구조로, 사이드바 네비게이션으로 페이지 전환한다.

### 5.1 페이지 구성

| 페이지 | 기능 |
|--------|------|
| 대시보드 | 사이트 현황 카드, 클라이언트 목록(승인/거부 버튼), 빠른 작업 |
| 큐시트 (편성표) | 사이트별 필터 탭, 항목 추가/삭제, 드래그 순서변경, 전체 옵션 제어, 저장 및 적용 |
| 콘텐츠 라이브러리 | 썸네일 그리드, 드래그&드롭 업로드, 드라이브 동기화 버튼, 삭제 |
| 설정 | 사이트 추가/삭제, 구글 드라이브 상태, 클라이언트-사이트 할당 |

### 5.2 편성표 항목 필드

| 필드 | 설명 | 옵션 |
|------|------|------|
| siteId | 대상 사이트 | 등록된 사이트 목록에서 선택 |
| file1 | 좌측(또는 단독) 파일 | 콘텐츠 라이브러리에서 선택 |
| file2 | 우측 파일 (독립 모드) | 콘텐츠 라이브러리에서 선택 |
| layoutType | 편성 유형 | independent(독립), split(분할) |
| duration | 표출 시간 (초) | 3~600 |
| videoDuration | 영상 재생 기준 | original(원본 길이), custom(지정 시간) |
| audio | 소리 | none(없음), left(좌), right(우) |
| transition | 전환 효과 | fade, cut, slide |
| validFrom / validTo | 유효 기간 | 날짜 또는 null(무제한) |
| enabled | 활성/비활성 | true/false |

---

## 6. 배포 구성

### 6.1 Railway 설정

| 항목 | 값 |
|------|-----|
| GitHub 저장소 | loginheaven-jpg/signage |
| Root Directory | host |
| Build Command | (자동 감지: npm install) |
| Start Command | npm start → node server.js |
| Custom Domain | signage.yebom.org |
| Port | Railway 자동 할당 (PORT 환경변수) |

### 6.2 Railway 환경변수

| 변수 | 값 |
|------|-----|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 서비스 계정 JSON 전체 내용 |
| `GDRIVE_FOLDER_ID` | `1NuQfKkX9nA_Dd8Fd75H9By5osyyQz4sm` |

### 6.3 DNS 설정

| 레코드 | 호스트 | 값 |
|--------|--------|-----|
| CNAME | signage | (Railway 프로젝트).up.railway.app |

---

## 7. 클라이언트 등록 및 승인 흐름

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  클라이언트 PC   │         │   호스트 서버    │         │   관리자 브라우저 │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                           │
         │  1. WebSocket 연결        │                           │
         │  register {name, id}      │                           │
         │ ─────────────────────────→│                           │
         │                           │  2. client_update 알림    │
         │                           │ ─────────────────────────→│
         │                           │                           │
         │  3. pending 응답          │                           │
         │ ←─────────────────────────│                           │
         │                           │                           │
         │                           │  4. 관리자가 "승인" 클릭  │
         │                           │ ←─────────────────────────│
         │                           │                           │
         │                           │  (사이트 자동 생성)       │
         │                           │                           │
         │  5. approved {siteId}     │                           │
         │ ←─────────────────────────│                           │
         │                           │                           │
         │  6. schedule_update       │                           │
         │ ←─────────────────────────│                           │
         │                           │                           │
         │  [전체화면 재생 시작]      │                           │
         │                           │                           │
```

---

## 8. 주요 설계 결정 사항

### 8.1 사이트 자동 생성

클라이언트 승인 시 사이트를 미선택하면 클라이언트 이름으로 사이트가 자동 생성된다. 이를 통해 관리자가 사전에 사이트를 등록할 필요 없이, 클라이언트 설치 → 승인만으로 편성표 운영이 가능하다.

### 8.2 편성표 이중 구조

편성표는 관리자 편집용(file1/file2 듀얼 구조)과 클라이언트 재생용(단일 url/mimeType)으로 분리된다. 서버의 `getSiteSchedule()` 함수가 변환을 담당한다. 독립 모드에서 file1과 file2는 각각 별도 재생 항목으로 변환되어 순차 재생된다.

### 8.3 승인 영속성

승인된 클라이언트는 `data/approved-clients.json`에 기록된다. 서버 재시작이나 클라이언트 재접속 시에도 승인 상태가 유지되어 자동으로 편성표를 수신한다.

### 8.4 콘텐츠 소스 이중화

콘텐츠는 두 가지 경로로 등록된다:
- **로컬 업로드**: 관리 UI에서 직접 업로드 (host/uploads/ 저장)
- **구글 드라이브**: 지정 폴더 자동 동기화 (3분 간격)

Railway 배포 환경에서는 파일 시스템이 ephemeral이므로, 재배포 시 로컬 업로드 파일은 초기화된다. 구글 드라이브 파일은 자동 재동기화된다.

---

## 9. 알려진 제한 사항 및 향후 과제

| 항목 | 상태 | 설명 |
|------|------|------|
| Railway 파일 영속성 | 제한 | 재배포 시 uploads/ 초기화 → 드라이브 연동 필수. 로컬 업로드 목록은 data/content.json에 영속화되나 파일 자체는 ephemeral |
| 분할 모드 재생 | 구현 | 좌/우 분할(side-by-side) 및 듀얼 모니터 분할 출력 지원 (§4.8) |
| 듀얼 모니터 | 구현 | 물리 디스플레이 2개 시 보조 창 자동 생성 (§4.8). 단일 디스플레이는 창 내 분할로 폴백 |
| 오프라인 재생 | 구현 | 편성표/미디어 로컬 캐시로 호스트·인터넷 단절 시에도 재생 지속 (§4.7) |
| 관리자 인증 | 구현 | ADMIN_PASSWORD 설정 시 HTTP Basic 인증. WebSocket 구독(읽기 전용 알림)은 미인증 |
| 웹 플레이어 | 보조 | host/public/player.html은 테스트용, 실 운영은 Electron 클라이언트 |
| HTTPS WebSocket | 자동 | Railway가 TLS 처리, 클라이언트는 wss:// 자동 사용 |

---

## 10. 로컬 개발 환경 설정

### 호스트 서버 로컬 실행

```bash
cd host
npm install
# 구글 드라이브 연동 시: credentials/service-account.json 배치
node server.js
# → http://localhost:3000 에서 관리 UI 접근
```

### 클라이언트 로컬 실행

```bash
cd client
npm install
npx electron .
# → 설정 화면에서 호스트 주소를 http://localhost:3000 으로 지정
```

---

## 11. 작업 이력

| 날짜 | 버전 | 내용 |
|------|------|------|
| 2026-07-07 | v1 | 초기 MVP — 단일 사이트, 기본 편성표, 클라이언트 구글 드라이브 직접 동기화 |
| 2026-07-08 | v2 | 호스트 서버 중앙 관리 전환, 구글 드라이브 서버 동기화, WebSocket 푸시 |
| 2026-07-08 | v3 | 다중 사이트, 확장 편성표(편성유형/소리/전환/유효기간), SPA 관리 UI |
| 2026-07-08 | v3.1 | 클라이언트 v2 — 설정 UI + 승인 대기 + 원클릭 설치 |
| 2026-07-08 | v3.2 | 하드코딩 사이트 제거, 승인 기반 동적 사이트 생성, 편성표 형식 변환 수정 |
| 2026-07-08 | v3.3 | 승인 재푸시 버그 수정, 클라이언트 오프라인/독립 재생(로컬 캐시), 분할·듀얼 모니터 재생, 관리자 인증, 로컬 콘텐츠 영속화 |

---

## 12. 트러블슈팅 가이드

### 클라이언트 블랙 스크린

- **원인**: 편성표 데이터 형식 불일치 (호스트 file1/file2 vs 클라이언트 url/filename)
- **해결**: v3.2에서 `getSiteSchedule()` 변환 로직 추가로 해결됨

### 구글 드라이브 연동 실패

- **Railway**: `GOOGLE_SERVICE_ACCOUNT_KEY` 환경변수에 서비스 계정 JSON 전체 입력
- **로컬**: `host/credentials/service-account.json` 파일 배치
- **권한**: 서비스 계정에 대상 폴더 공유 필요

### Railway 배포 실패

- Root Directory가 `host`로 설정되어 있는지 확인
- `package.json`의 `start` 스크립트가 `node server.js`인지 확인

### 클라이언트 재접속 시 승인 안됨

- `data/approved-clients.json`에 해당 clientId가 있는지 확인
- clientId는 최초 설정 시 자동 생성되며 config.json에 저장됨
- config.json 삭제 시 새 ID가 발급되므로 재승인 필요
