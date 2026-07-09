@echo off
chcp 65001 >nul
title 디지털 게시판 클라이언트 설치 / 업데이트

echo.
echo ╔══════════════════════════════════════════╗
echo ║  디지털 게시판 클라이언트 설치 / 업데이트 ║
echo ╚══════════════════════════════════════════╝
echo.

:: ─── 신규/업데이트 자동 판별 ─────────────────────────────
set "MODE=신규 설치"
if exist "%~dp0node_modules" set "MODE=업데이트"
echo   ▶ 설치 유형: %MODE%
if "%MODE%"=="업데이트" (
    echo     (기존 설치 폴더를 감지했습니다. 파일만 갱신합니다.)
    echo     ※ 실행 중인 앱이 있으면 Ctrl+Shift+Q 로 먼저 종료하세요.
)
echo.

:: ─── 1. Node.js 확인 ────────────────────────────────────
echo [1/4] Node.js 확인 중...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo ⚠  Node.js가 설치되어 있지 않습니다.
    echo    https://nodejs.org 에서 LTS 버전을 설치한 후 다시 실행하세요.
    echo.
    start https://nodejs.org/ko/download/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo    ✓ Node.js %NODE_VER% 확인됨
echo.

:: ─── 2. 의존성 설치/확인 ───────────────────────────────
echo [2/4] 패키지 확인 중... (신규는 다운로드, 기존은 확인만)
call npm install --production 2>nul
if %ERRORLEVEL% neq 0 (
    echo    npm install 실패. 네트워크를 확인하세요.
    pause
    exit /b 1
)
echo    ✓ 패키지 준비 완료
echo.

:: ─── 3. 윈도우 시작프로그램 등록 ────────────────────────
echo [3/4] 윈도우 시작프로그램 등록 중...

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_NAME=디지털게시판.lnk"
set "SCRIPT_PATH=%~dp0start.bat"

:: VBScript로 바로가기 생성 (이미 있으면 덮어씀)
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\create_shortcut.vbs"
echo sLinkFile = "%STARTUP_FOLDER%\%SHORTCUT_NAME%" >> "%TEMP%\create_shortcut.vbs"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\create_shortcut.vbs"
echo oLink.TargetPath = "%SCRIPT_PATH%" >> "%TEMP%\create_shortcut.vbs"
echo oLink.WorkingDirectory = "%~dp0" >> "%TEMP%\create_shortcut.vbs"
echo oLink.WindowStyle = 7 >> "%TEMP%\create_shortcut.vbs"
echo oLink.Description = "디지털 게시판 클라이언트 자동 시작" >> "%TEMP%\create_shortcut.vbs"
echo oLink.Save >> "%TEMP%\create_shortcut.vbs"
cscript //nologo "%TEMP%\create_shortcut.vbs"
del "%TEMP%\create_shortcut.vbs"

echo    ✓ 윈도우 부팅 시 자동 실행 등록 완료
echo.

:: ─── 4. 실행 ────────────────────────────────────────────
echo [4/4] 클라이언트 실행 중...
echo.
echo ╔══════════════════════════════════════════╗
echo ║  %MODE% 완료!
echo ║                                          ║
echo ║  • 클라이언트가 자동으로 시작됩니다       ║
echo ║  • (신규) 설정 화면에서 이름/서버 입력    ║
echo ║  • PC 재부팅 시 자동 실행됩니다           ║
echo ║                                          ║
echo ║  단축키:                                 ║
echo ║    Ctrl+Shift+P  멈추기 / 재생하기       ║
echo ║    Ctrl+Shift+S  설정 화면               ║
echo ║    Ctrl+Shift+F  전체화면 토글           ║
echo ║    Ctrl+Shift+Q  앱 종료                 ║
echo ╚══════════════════════════════════════════╝
echo.

:: Electron 실행
call npx electron .
