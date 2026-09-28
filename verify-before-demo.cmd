@echo off
setlocal enabledelayedexpansion
title SmartLife - Verify before demo (typecheck / test / build:web)

REM ============================================================
REM  Runs the three checks that must pass before the demo:
REM    1. npm run typecheck
REM    2. npm test
REM    3. npm run build:web   (static web export into .\dist)
REM
REM  Read-only as far as your code and GitHub are concerned:
REM    - no git add / commit / push / merge
REM    - no firebase deploy
REM    - does not edit any source file
REM  The only things it writes are .\dist (rebuilt by build:web)
REM  and the log file verify-before-demo.log next to this script.
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo   SmartLife - verify before demo
echo ============================================================
echo.

REM ---------- sanity checks ----------
if not exist "package.json" (
  echo [ERROR] package.json not found.
  echo         Put this file in the Final-Project folder and run it there.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [ERROR] node_modules is missing. Install dependencies first:
  echo.
  echo           npm install
  echo.
  pause
  exit /b 1
)

if not exist "functions\node_modules\" (
  echo [WARN] functions\node_modules is missing.
  echo        The last part of "npm test" ^(test:pdf-feedback^) builds the
  echo        functions folder and will fail without it. Fix with:
  echo.
  echo          npm --prefix functions install
  echo.
)

if not exist ".env.local" (
  echo [WARN] .env.local is missing - build:web will fail because the
  echo        web bundle needs the Firebase config from that file.
  echo.
)

set "LOG=%~dp0verify-before-demo.log"
> "%LOG%" echo SmartLife verify run - %DATE% %TIME%

call :step typecheck "npm run typecheck"
set "R_TYPE=!STEP_RESULT!"

call :step test "npm test"
set "R_TEST=!STEP_RESULT!"

call :step build:web "npm run build:web"
set "R_WEB=!STEP_RESULT!"

REM ---------- summary ----------
echo.
echo ============================================================
echo   RESULT
echo ============================================================
echo     typecheck : !R_TYPE!
echo     test      : !R_TEST!
echo     build:web : !R_WEB!
echo.
echo   Full output: %LOG%
echo.
echo   Nothing was committed, pushed, merged or deployed.
echo ============================================================
echo.

>> "%LOG%" echo.
>> "%LOG%" echo SUMMARY: typecheck=!R_TYPE!  test=!R_TEST!  build:web=!R_WEB!

set "ANYFAIL="
if /i "!R_TYPE!"=="FAIL" set "ANYFAIL=1"
if /i "!R_TEST!"=="FAIL" set "ANYFAIL=1"
if /i "!R_WEB!"=="FAIL"  set "ANYFAIL=1"

if defined ANYFAIL (
  echo [!] At least one check failed. Opening the log so you can see
  echo     the error - copy it and send it back to Claude.
  echo.
  start "" notepad "%LOG%"
  pause
  exit /b 1
)

echo [OK] All three checks passed. Ready for the demo.
echo.
pause
exit /b 0


REM ============================================================
REM  :step <name> "<command>"
REM  Runs one check, appends its output to the log, sets STEP_RESULT
REM ============================================================
:step
set "NAME=%~1"
set "CMDLINE=%~2"
echo ------------------------------------------------------------
echo   [!NAME!] running: !CMDLINE!
echo   Output goes to the log. This can take a few minutes -
echo   the window is not frozen.
echo ------------------------------------------------------------
>> "%LOG%" echo.
>> "%LOG%" echo ===== !NAME! : !CMDLINE! =====
call !CMDLINE! >> "%LOG%" 2>&1
if errorlevel 1 (
  set "STEP_RESULT=FAIL"
) else (
  set "STEP_RESULT=PASS"
)
>> "%LOG%" echo ===== !NAME! result: !STEP_RESULT! =====
echo   [!NAME!] !STEP_RESULT!
echo.
exit /b 0
