@echo off
chcp 65001 >nul
title 디지털 게시판 클라이언트 설치

echo ============================================
echo   디지털 게시판 - 클라이언트 설치
echo ============================================
echo.

:: Node.js 설치 확인
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo        https://nodejs.org 에서 LTS 버전을 설치해 주세요.
    echo.
    pause
    exit /b 1
)

echo [1/4] Node.js 확인... OK
for /f "tokens=*" %%i in ('node -v') do echo        버전: %%i
echo.

:: 의존성 설치
echo [2/4] 의존성 설치 중...
call npm install --production 2>nul
if %errorlevel% neq 0 (
    echo [오류] 의존성 설치 실패
    pause
    exit /b 1
)
echo        완료!
echo.

:: config.js 확인
echo [3/4] 설정 파일 확인...
if not exist "config.js" (
    echo [오류] config.js 파일이 없습니다.
    pause
    exit /b 1
)
echo        config.js 확인 OK
echo.

:: 서비스 계정 키 확인
if not exist "credentials\service-account.json" (
    echo [경고] credentials\service-account.json 파일이 없습니다.
    echo        구글 드라이브 동기화가 작동하지 않습니다.
    echo        나중에 파일을 배치하면 자동으로 동기화가 시작됩니다.
    echo.
) else (
    echo        service-account.json 확인 OK
    echo.
)

:: 자동 시작 등록
echo [4/4] Windows 자동 시작 등록...
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP_DIR%\디지털게시판.bat"

:: 시작 배치 파일 생성
echo @echo off > "%SHORTCUT%"
echo cd /d "%~dp0" >> "%SHORTCUT%"
echo start "" npx electron . >> "%SHORTCUT%"

echo        자동 시작 등록 완료!
echo        위치: %SHORTCUT%
echo.

echo ============================================
echo   설치 완료!
echo ============================================
echo.
echo   실행 방법:
echo     방법 1: start.bat 더블클릭
echo     방법 2: PC 재부팅 (자동 실행)
echo.
echo   설정 변경:
echo     config.js 파일을 메모장으로 편집
echo.
pause
