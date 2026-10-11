@echo off
setlocal
set "H3_COMFY_PYTHON=%~dp0.venv\Scripts\python.exe"

echo [H3 ComfyUI] Stopping this project's ComfyUI only...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; try { $servers=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $env:H3_COMFY_PYTHON -and $_.CommandLine -match '(?:^|\s)main\.py(?:\s|$)' -and $_.CommandLine -match '--port\s+8188(?:\s|$)' }); if ($servers.Count -eq 0) { Write-Host '[H3 ComfyUI] Already stopped.'; exit 0 }; foreach ($server in $servers) { taskkill.exe /PID ([int]$server.ProcessId) /T /F; if ($LASTEXITCODE -ne 0) { exit 1 } }; Write-Host '[H3 ComfyUI] Stopped.'; exit 0 } catch { Write-Error $_; exit 1 }"
set "H3_COMFY_EXIT=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %H3_COMFY_EXIT%
