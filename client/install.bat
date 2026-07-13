@echo off
title Digital Signage Client - Install / Update

echo.
echo +==============================================+
echo ^|   Digital Signage Client - Install / Update  ^|
echo +==============================================+
echo.

:: --- Detect new install vs update ---------------------
set "MODE=New install"
if exist "%~dp0node_modules" set "MODE=Update"
echo   ^> Setup type: %MODE%
if "%MODE%"=="Update" (
    echo     ^(Existing install detected. Refreshing files only.^)
    echo     * If the app is running, quit it first with Ctrl+Shift+Q.
)
echo.

:: --- 1. Check Node.js ---------------------------------
echo [1/4] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo [!] Node.js is not installed.
    echo     Install the LTS version from https://nodejs.org and run this again.
    echo.
    start https://nodejs.org/en/download/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo    [OK] Node.js %NODE_VER% detected
echo.

:: --- 2. Install / check dependencies ------------------
echo [2/4] Preparing packages... ^(download on new install, verify on update^)
call npm install --production 2>nul
if %ERRORLEVEL% neq 0 (
    echo    npm install failed. Please check your network.
    pause
    exit /b 1
)
echo    [OK] Packages ready
echo.

:: --- 3. Register Windows startup ----------------------
echo [3/4] Registering Windows startup...

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_NAME=DigitalSignage.lnk"
set "SCRIPT_PATH=%~dp0start.bat"

:: Create shortcut via VBScript (overwrites if it exists)
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%TEMP%\create_shortcut.vbs"
echo sLinkFile = "%STARTUP_FOLDER%\%SHORTCUT_NAME%" >> "%TEMP%\create_shortcut.vbs"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%TEMP%\create_shortcut.vbs"
echo oLink.TargetPath = "%SCRIPT_PATH%" >> "%TEMP%\create_shortcut.vbs"
echo oLink.WorkingDirectory = "%~dp0" >> "%TEMP%\create_shortcut.vbs"
echo oLink.WindowStyle = 7 >> "%TEMP%\create_shortcut.vbs"
echo oLink.Description = "Digital Signage client auto-start" >> "%TEMP%\create_shortcut.vbs"
echo oLink.Save >> "%TEMP%\create_shortcut.vbs"
cscript //nologo "%TEMP%\create_shortcut.vbs"
del "%TEMP%\create_shortcut.vbs"

echo    [OK] Auto-start on Windows boot registered
echo.

:: --- 4. Launch ----------------------------------------
echo [4/4] Starting client...
echo.
echo +==============================================+
echo ^|   %MODE% complete!
echo ^|                                              ^|
echo ^|   - The client will start automatically      ^|
echo ^|   - (New) Enter name/server on setup screen  ^|
echo ^|   - Starts automatically when the PC reboots ^|
echo ^|                                              ^|
echo ^|   Shortcuts:                                 ^|
echo ^|     Ctrl+Shift+P   Pause / Play              ^|
echo ^|     Ctrl+Shift+S   Settings screen           ^|
echo ^|     Ctrl+Shift+F   Toggle fullscreen         ^|
echo ^|     Ctrl+Shift+Q   Quit app                  ^|
echo +==============================================+
echo.

:: Launch Electron
call npx electron .
