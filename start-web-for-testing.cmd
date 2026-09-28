@echo off
title SmartLife web dev server - keep this window open
cd /d "%~dp0"

if not exist "node_modules\expo\bin\cli" (
  echo [ERROR] node_modules is missing. Run "npm install" once first.
  pause
  exit /b 1
)

echo ============================================================
echo   SmartLife web dev server  -  http://localhost:8081
echo.
echo   Keep this window OPEN while testing.
echo   Close it (or press Ctrl+C) when you are done.
echo.
echo   The first page load takes about 1 minute while it bundles.
echo   Nothing is committed, pushed or deployed by this script.
echo ============================================================
echo.

node node_modules\expo\bin\cli start --web --port 8081

echo.
echo Server stopped.
pause
