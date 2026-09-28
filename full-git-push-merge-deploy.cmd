@echo off
title SmartLife - DISABLED (dangerous script)

REM ============================================================
REM  This script has been disabled on purpose.
REM
REM  As originally written it would:
REM    - "git push -u origin !CURRENT_BRANCH!" and
REM      "git push origin master"
REM    - run "firebase deploy --only firestore:rules"
REM
REM  Under this project's current git remotes, "origin" points at
REM  your FRIEND's repository (faloxsgz5-oss/Final-Project), not
REM  yours. Running this would have pushed straight to your
REM  friend's master branch and deployed Firestore rules to the
REM  shared production Firebase project - without asking your
REM  friend first, which breaks the project's own rule:
REM    "ห้าม push ของเพื่อนเอง ... ห้ามอัปทับ GitHub เพื่อนโดยพลการ"
REM
REM  Use push-to-my-github.cmd instead - it only pushes to your
REM  own "personal" remote, refuses to touch master/main, never
REM  force-pushes, and never deploys anything.
REM
REM  The original commands are kept below as a comment, in case
REM  you ever need to see exactly what this used to do.
REM ============================================================

echo.
echo [DISABLED] This script has been turned off because it pushes
echo            straight to your friend's repo and deploys to
echo            production Firebase.
echo.
echo            Use push-to-my-github.cmd instead - it only pushes
echo            to YOUR OWN GitHub repo and never deploys anything.
echo.
pause
exit /b 1

REM ---------------- original script, kept for reference ----------------
REM for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%B"
REM git add -u
REM git commit -m "..."
REM git push -u origin !CURRENT_BRANCH!
REM git checkout master
REM git merge !CURRENT_BRANCH!
REM git push origin master
REM firebase deploy --only firestore:rules
REM ------------------------------------------------------------------------
