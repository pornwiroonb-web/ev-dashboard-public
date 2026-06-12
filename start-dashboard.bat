@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=C:\Users\PRONWIROON\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  echo ไม่พบ Node.js ที่ต้องใช้รันโปรแกรม
  echo กรุณาแจ้งผม แล้วผมจะช่วยทำตัวเปิดแบบสำรองให้
  pause
  exit /b 1
)

start "EV Dashboard" /b "%NODE_EXE%" server.js
timeout /t 2 /nobreak >nul
start "" http://ev-dashboard.local:3000
echo โปรแกรมกำลังทำงานที่ http://ev-dashboard.local:3000
echo ปิดหน้าต่างนี้ได้หลังใช้งานเสร็จ
pause >nul
