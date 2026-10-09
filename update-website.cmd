@echo off
setlocal
cd /d "%~dp0"

echo ===============================================
echo   อัปเดตเว็บไซต์ SmartLife (smartlife-budget.web.app)
echo   ก่อน deploy จะตรวจว่าไม่มีไฟล์ที่ยังไม่ commit และตรงกับ origin/master
echo   แล้วแสดงสิ่งที่จะขึ้นเว็บ ให้พิมพ์รหัส commit เพื่อยืนยันก่อนทุกครั้ง
echo ===============================================
echo.

rem All checks and the confirmation live in scriptsdeploy-guard.cjs.
call npm run deploy:web

echo.
if %ERRORLEVEL% NEQ 0 (
  echo ยังไม่ได้ deploy อะไรขึ้นเว็บ กรุณาอ่านเหตุผลด้านบน
) else (
  echo เสร็จแล้ว! เปิดดูได้ที่ https://smartlife-budget.web.app
)
echo.
pause
