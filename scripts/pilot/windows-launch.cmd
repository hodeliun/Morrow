@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-launch.ps1"
set "MORROW_PILOT_EXIT=%ERRORLEVEL%"
if not "%MORROW_PILOT_EXIT%"=="0" (
  echo The pilot launcher refused to continue. Review the message above, then close this window.
  pause
)
endlocal & exit /b %MORROW_PILOT_EXIT%
