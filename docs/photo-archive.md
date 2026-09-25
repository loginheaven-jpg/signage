# 사진 보관함 (서버 1.2.0)

콘트롤 센터 상단의 **사진 보관함** 버튼 또는 `/photos`에서 사용한다.
휴대폰 사진은 가로·세로 중 긴 변 최대 **3840픽셀**, JPEG 품질 90%로 전송한다.
작은 사진은 확대하지 않는다. 설치형 플레이어는 전체 화면 크기에 맞춰 표시하므로
이 변경을 위해 클라이언트를 다시 설치할 필요는 없다. 열린 휴대폰 업로드 페이지는 새로고침한다.

## 저장과 삭제

- 기본 사진 폴더: `1CvycMd8O3KTb7sFpMJj9IL6DUlWE5mzK`.
  `GDRIVE_PHOTO_FOLDER_ID`로 변경할 수 있다. 기존 순차 재생용 `GDRIVE_FOLDER_ID`와 독립이다.
- 업로드 성공 응답 전에 `DATA_DIR/photo-archive/`에 사진과 문구·등록일시·장소를 저장한다.
  모니터 표시는 Google 응답을 기다리지 않는다. 실패하면 최대 30분 간격으로 계속 재시도한다.
- Google의 사전 발급 파일 ID를 저장한 뒤 업로드하므로 응답 유실/재시작 후 재시도해도 중복 파일을 만들지 않는다.
- 보관 완료 후 서버의 보관용 원본 복사본은 정리한다. 사진은 인증된 서버 경유로 Drive에서 읽는다.
  Drive 파일 설명에 문구와 원래 등록일시를 함께 기록하여 서버 인덱스를 재구성할 수 있다.
- 라이브 종료/TTL은 화면용 임시 파일만 지운다. 보관 사진은 남는다.
- 업로더의 취소 및 보관함의 삭제는 화면에서 내리고 Drive 휴지통으로 이동한다.
  통신/권한 오류 시 `삭제 처리 중` 상태로 남겨 재시도한다. 영구 삭제 API는 사용하지 않는다.
- 날짜 필터와 날짜·시간 표시는 한국 시간의 **등록일시**이며 EXIF 촬영 시각이 아니다.
- 지정 폴더에 직접 추가한 이미지도 3분마다 목록에 반영한다. 하위 폴더는 탐색하지 않는다.
- 관리 화면/API에는 기존 `ADMIN_USER`/`ADMIN_PASSWORD` 인증이 적용된다.
  사진 복사는 HTTPS에서 PNG 이미지로 클립보드에 기록한다. 미지원 브라우저에서는 다운로드를 안내한다.

## 서버 영구 저장소 (필수)

Railway의 영구 볼륨을 `/data`에 연결하고 아래 환경변수를 설정한다.
환경변수만 지정하고 실제 볼륨을 연결하지 않으면 재배포 시 대기 중인 사진과 Google 연결 정보가 사라질 수 있다.

```text
DATA_DIR=/data
UPLOADS_DIR=/data/uploads
GDRIVE_PHOTO_FOLDER_ID=1CvycMd8O3KTb7sFpMJj9IL6DUlWE5mzK
PUBLIC_BASE_URL=https://signage.yebom.org
```

사진, 인덱스, OAuth 갱신 토큰은 공개 uploads 경로 밖에 저장한다.
토큰 파일 `DATA_DIR/photo-archive/google-oauth.json`은 저장소에 커밋하거나 사용자에게 전달하지 않는다.

## 개인 ‘내 드라이브’ 폴더 연결

서비스 계정에 폴더 편집 권한을 주는 것만으로는 개인 Drive에 새 파일을 생성할 수 없다.
서비스 계정에는 파일을 소유할 개인 저장 공간이 없기 때문이다. 폴더 소유자 계정으로 OAuth 연결한다.
기존 순차 재생의 서비스 계정 읽기 전용 동기화는 그대로 유지한다.

1. Google Cloud의 해당 프로젝트에서 Google Drive API를 활성화한다.
2. Google Auth Platform에서 동의 화면을 설정하고 **웹 애플리케이션** OAuth 클라이언트를 만든다.
   승인된 리디렉션 URI는 정확히 `https://signage.yebom.org/api/photos/oauth/callback`으로 등록한다.
3. 발급받은 값을 Railway 서비스의 비밀 환경변수에 입력한다. 채팅이나 Git에 키를 적지 않는다.

   ```text
   GOOGLE_PHOTO_OAUTH_CLIENT_ID=<웹 애플리케이션 클라이언트 ID>
   GOOGLE_PHOTO_OAUTH_CLIENT_SECRET=<해당 클라이언트 보안 비밀>
   ```

4. 서버 재배포 후 사진 보관함의 **Google 계정 연결**을 눌러 폴더 소유자로 로그인하고 동의한다.
   서버는 폴더 편집 권한을 확인한 후 갱신 토큰을 영구 저장하며, 대기 사진을 자동 전송한다.
5. 테스트용 사진 한 장을 올려 `드라이브 보관 완료` 및 실제 폴더 파일을 확인한다.

이 구현은 이미 지정된 기존 폴더를 읽고 쓰기 위해 `https://www.googleapis.com/auth/drive` 범위를 요청한다.
서버의 파일 조회·생성·삭제 코드는 지정 사진 폴더로 제한한다. Google 동의 화면에는 더 넓은 Drive 권한이 표시된다.
외부 앱이 **테스트 중(Testing)** 상태이면 이 권한의 갱신 토큰은 7일 후 만료될 수 있다.
무인 운영 전에 Google의 앱 게시/검증 요구사항에 맞는 운영 상태로 전환해야 한다.
권한 철회/만료 시 연결 오류를 표시하고 사진을 서버에 유지한다. 관리자가 다시 연결하면 전송을 재개한다.

## 조직 ‘공유 드라이브’ 폴더

API에서 폴더의 `driveId`가 확인되면 서비스 계정으로 직접 업로드할 수 있다.
폴더에 파일 추가 및 휴지통 이동 권한을 부여한다. 추가 권한만 있으면 저장은 가능하지만 삭제는 실패할 수 있다.
개인 Drive의 ‘공유 문서함’ 또는 공유된 폴더는 조직 ‘공유 드라이브’와 다르다.

## 검증

`npm test` (host): 라이브 HTTP/WebSocket 회귀 검사, 독립 보관/재시작 복원,
Drive 타임아웃 후 중복 방지, 삭제·업로드 경합, 폴더 범위 제한, OAuth 상태·쿠키 검증.
Google API 테스트는 가짜 Drive 응답을 사용한다. 운영 계정에서 실제 저장 성공 여부는 별도로 확인한다.

참고: [Drive 파일 생성](https://developers.google.com/workspace/drive/api/guides/folder),
[중복 없는 재시도](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[OAuth 갱신 토큰](https://developers.google.com/identity/protocols/oauth2).
