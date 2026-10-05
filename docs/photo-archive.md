# 사진 보관함 및 Google 연결

카메라의 목적·연도·행사·원본·재시도 설계는 [camera-workflow.md](camera-workflow.md)를 참고한다.
관리 보관함은 `/photos`이며 관리자 로그인이 필요하다. 모니터 표출과 독립적으로 원본을 조회·다운로드·삭제한다.
사진 복사는 지원하는 HTTPS 브라우저에서 PNG로 변환해 클립보드에 기록한다.

## 서버 설정

Node.js 22 이상을 사용한다. Railway 영구 볼륨을 `/data`에 연결하고 다음을 설정한다.

```text
DATA_DIR=/data
UPLOADS_DIR=/data/uploads
GDRIVE_CAMERA_ROOT_ID=1sOi_69AEMwqoMbIyQ-vvZ2dpW7SD-Yfd
PUBLIC_BASE_URL=https://signage.yebom.org
CAMERA_PUBLIC_URL=https://camera.yebom.org
```

`GDRIVE_CAMERA_ROOT_ID`는 생략하면 위 교회사진 루트를 사용한다. 기존 `GDRIVE_PHOTO_FOLDER_ID`는 새 루트 설정에 사용하지 않는다.
기존 보관 기록은 유지한다. 순환 콘텐츠의 `GDRIVE_FOLDER_ID`와 카메라 루트는 독립적이다.
접속에는 별도의 `ADMIN_PASSWORD`, `CAMERA_PASSWORD`가 필요하다.
사진·접수 기록·폴더 생성 journal·OAuth 갱신 토큰·기기 서명 키는 비공개 `DATA_DIR/photo-archive/`에 둔다.
영구 볼륨 없이 환경변수만 지정하면 재배포 때 대기 사진과 연결 정보가 사라질 수 있다.
하나의 DATA_DIR에는 서버 쓰기 프로세스를 하나만 사용한다.

## Google 계정 연결

기존 `drive.file` 권한은 루트 아래 기존 연도·행사 폴더 전체에 대한 조회·쓰기를 보장하지 않는다.
이번 버전은 기존 폴더 구조를 사용하기 위해 **`https://www.googleapis.com/auth/drive`**를 요청한다.
Google 권한 자체는 전체 Drive 조회·관리이며, 지정 루트 제한은 앱 서버에서 부모 폴더 검증으로 적용한다.
관리자는 Google Cloud 앱 동의 설정과 검증 요구를 확인한 뒤 아래 절차로 명시적으로 다시 연결한다.
기존 scope/루트가 다른 토큰을 자동으로 재사용하거나 권한을 확장하지 않는다.

1. 같은 Google Cloud 프로젝트에서 Drive API와 Picker API를 활성화한다.
2. 웹 애플리케이션 OAuth 클라이언트의 승인된 리디렉션 URI에
   `https://signage.yebom.org/api/photos/oauth/callback`을 등록한다.
3. 서버 비밀 변수에 다음을 입력한다. 키/비밀/토큰을 Git이나 채팅에 기록하지 않는다.

   ```text
   GOOGLE_PHOTO_OAUTH_CLIENT_ID=<웹 클라이언트 ID>
   GOOGLE_PHOTO_OAUTH_CLIENT_SECRET=<클라이언트 보안 비밀>
   GOOGLE_PICKER_API_KEY=<같은 프로젝트의 브라우저 API 키>
   GOOGLE_PICKER_APP_ID=<프로젝트 숫자 ID>
   ```

   Picker APP_ID가 없으면 OAuth 클라이언트 ID의 숫자 접두부를 사용한다.
   API 키의 웹사이트 제한에 `https://signage.yebom.org/*`, `https://docs.google.com/*`를 등록한다.
   API 제한에는 Google Picker API를 지정한다.
4. 동의 화면 데이터 액세스에 `drive` 범위를 설정하고 앱의 검증/게시 요구를 확인한다.
5. 관리자 `/photos`에서 Google 계정을 다시 연결한다. 연결 계정은 루트 및 행사 폴더의 편집 권한이 필요하다.
6. 돌아온 화면의 Google 폴더 선택창에서 **#교회사진영상 루트**를 선택한다.
   다른 폴더는 거절한다. 실제 접근·편집 권한 확인 뒤 갱신 토큰을 영구 저장한다.
7. 카메라에서 행사 하나와 사진 한 장을 지정해 원본 저장·파일명·모니터 선택 표출·삭제를 운영 계정으로 확인한다.

OAuth 및 Picker 임시 세션은 브라우저에 묶어 10분간 유지한다. 단기 액세스 토큰은 같은 출처 POST와 세션 검증 뒤 전달한다.
갱신 토큰과 OAuth 비밀은 브라우저나 플레이어에 전달하지 않는다.
기존 순환 콘텐츠는 별도의 서비스 계정 읽기 전용 동기화를 유지한다. 개인 내 드라이브의 파일 보관에는 사용자 OAuth를 사용한다.

## 상태와 삭제

서버 접수 완료 전에 원본과 메타데이터를 기록한다. Google 전송은 비동기로 재시도하며 모니터 표시를 기다리게 하지 않는다.
Drive 파일 ID를 미리 저장해 업로드 응답 유실 후에도 동일 ID로 재시도한다.
실제 Drive 저장이 확인된 원본의 서버 복사본은 정리한다. 목록에는 행사·업로더·사진 날짜를 함께 표시한다.
연도·행사 폴더의 이미지와 기존 루트 이미지를 동기화하고 메타데이터로 인덱스를 재구성할 수 있다.
이전 루트의 로컬 보관 기록은 유지하되 이전 루트 전체를 새 루트로 자동 이동하지 않는다.
폴더 목록 동기화 오류가 새 사진의 원본 접수나 정상 보관 대기열을 중단시키지 않도록 분리한다.
모니터 사진 TTL·접수 종료는 Drive 원본에 영향을 주지 않는다.
삭제는 부모 범위를 확인한 뒤 Drive 휴지통으로 이동하며, 이동·권한 오류는 삭제 처리 중으로 유지한다.

## 검증

`cd host; npm test`는 가짜 Drive와 실제 로컬 HTTP/WebSocket/SMTP를 사용한다.
운영 OAuth 승인과 Google 저장 성공은 별도로 확인한다.
참고: [Drive 권한](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[사전 ID로 파일·폴더 생성](https://developers.google.com/workspace/drive/api/guides/create-file),
[폴더 생성](https://developers.google.com/workspace/drive/api/guides/folder).
