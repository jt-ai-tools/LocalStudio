@echo off
setlocal
cd /d "%~dp0ComfyUI"

powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 8188 -ErrorAction SilentlyContinue) { exit 1 }; exit 0"
if errorlevel 1 (
  echo [H3 ComfyUI] Port 8188 is already in use. No additional server was started.
  exit /b 1
)

"%~dp0.venv\Scripts\python.exe" main.py --listen 127.0.0.1 --port 8188 --enable-cors-header --disable-auto-launch
set "H3_COMFY_EXIT=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %H3_COMFY_EXIT%
