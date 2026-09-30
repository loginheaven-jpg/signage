# 관리자 접속과 예봄 카메라

## 배포 전 설정

Railway signage 서비스의 Variables에서 다음 값을 설정한다. 실제 암호를 소스 코드나 이 문서에 기록하지 않는다.

| 변수 | 값 |
| --- | --- |
| ADMIN_PASSWORD | 교회 관리자가 정한 관리자 암호 |
| CAMERA_PASSWORD | 교회 관리자가 정한 촬영용 암호 |
| PUBLIC_BASE_URL | `https://signage.yebom.org` (기존 값 유지) |
| CAMERA_PUBLIC_URL | 도메인 연결 전에는 `https://signage.yebom.org/camera`, 연결 후에는 `https://camera.yebom.org` |

프로덕션에서 암호가 비어 있으면 접속을 차단한다. 암호 설정을 먼저 완료한 뒤 이 버전을 배포한다. 기존 HTTP Basic 로그인이 브라우저 로그인 화면으로 바뀐다.

Railway Settings → Networking → Custom Domain에 `camera.yebom.org`를 추가하고, yebom.org DNS 관리 화면에서 Railway가 표시하는 CNAME 및 필요한 검증 레코드를 그대로 등록한다. 실제 대상 값을 추측하지 않는다. HTTPS 인증서 발급을 확인한 뒤 CAMERA_PUBLIC_URL을 변경한다. Google OAuth/Picker는 기존 관리자 도메인에서만 사용한다.

## 동작

- 관리 화면과 사진 보관함은 관리자 로그인이 필요하다.
- `/camera`, `/m`, `/m.html` 및 카메라 도메인의 첫 화면은 촬영용 로그인이 필요하다. 기존 QR의 토큰만으로 암호를 우회할 수 없다.
- 서명된 HttpOnly 쿠키를 최대 1년간 유지한다. DATA_DIR의 browser-auth.json으로 재배포 후에도 유지한다. 암호 변경 또는 해당 역할의 전체 로그아웃 시 기존 쿠키를 무효화한다. 브라우저 데이터 삭제, 비공개 모드, 다른 브라우저에서는 다시 로그인한다.
- 카메라 접수 OFF는 새 사진 접수만 막는다. 이미 접수한 사진, Google Drive 보관함, 편성표는 유지한다. 화면 정리는 별도의 즉시 종료를 사용한다.
- 설치형 모니터는 기존 승인된 WebSocket 연결과 업데이트 경로를 사용한다. 관리자 암호를 모니터에 입력할 필요가 없다.
- 촬영 화면의 설치 버튼을 사용한다. iPhone에서는 Safari 공유 → 홈 화면에 추가. 브라우저와 설치된 웹앱의 저장소가 분리되는 환경에서는 최초 설치 후 한 번 더 로그인이 필요할 수 있다.
- 오프라인에서는 전송 완료로 표시하지 않는다. 서비스 워커는 정적인 오프라인 안내만 캐시하며 사진, API 응답, 로그인 화면은 캐시하지 않는다.

## 검증

`cd host; npm test`로 인증 역할 분리, 재시작, 세션 폐기, CSRF 차단 및 기존 업로드/설치형 전달/업데이트 회귀를 확인한다. 실제 휴대폰 설치와 DNS/HTTPS는 운영 환경에서 별도로 확인한다.
