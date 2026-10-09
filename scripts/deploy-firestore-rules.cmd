@echo off
cd /d "%~dp0.."
echo Deploying SmartLife Firestore rules (checked and confirmed by scriptsdeploy-guard.cjs)...
call npm run deploy:firestore-rules
if errorlevel 1 (
  echo.
  echo Nothing was deployed, or the deployment failed. Keep this window open and check the message above.
  pause
  exit /b 1
)
echo.
echo Firestore rules deployed successfully.
pause
