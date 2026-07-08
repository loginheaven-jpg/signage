@echo off
chcp 65001 >nul
title 디지털 게시판 - 자동 시작 해제

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP_DIR%\디지털게시판.bat"

if exist "%SHORTCUT%" (
    del "%SHORTCUT%"
    echo 자동 시작이 해제되었습니다.
) else (
    echo 자동 시작이 등록되어 있지 않습니다.
)

pause
