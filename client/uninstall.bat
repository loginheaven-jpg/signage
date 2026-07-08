@echo off
chcp 65001 >nul
title 디지털 게시판 클라이언트 제거

echo.
echo  디지털 게시판 클라이언트 자동시작을 해제합니다.
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_NAME=디지털게시판.lnk"

if exist "%STARTUP_FOLDER%\%SHORTCUT_NAME%" (
    del "%STARTUP_FOLDER%\%SHORTCUT_NAME%"
    echo  ✓ 자동시작 해제 완료
) else (
    echo  자동시작이 등록되어 있지 않습니다.
)

echo.
echo  프로그램 폴더는 수동으로 삭제하세요.
echo.
pause
