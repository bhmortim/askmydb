@echo off
rem  askmydb launcher for Windows — double-click this file to start.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   askmydb needs Node.js, which isn't installed yet.
  echo   1. Get it free at https://nodejs.org  ^(click the big "LTS" button, install^)
  echo   2. Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   First-time setup: installing components ^(one minute^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Setup failed. Please send this window to whoever gave you askmydb.
    pause
    exit /b 1
  )
)

echo.
echo   Starting askmydb. Your browser will open at http://localhost:3600
echo   Leave this window open while you use it. Close it to quit.
echo.
start "" cmd /c "timeout /t 3 >nul & start "" http://localhost:3600"
node server.js
pause
