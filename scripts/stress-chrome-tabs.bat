@echo off
REM stress-chrome-tabs.bat - Open URL in Chrome, new tab every ~3s. Ctrl+C to stop.
REM Edit TARGET_URL. Edit ping -n 4 (use -n 11 for ~10s delay).

set "TARGET_URL=https://meta.mmh-virtual.jp/"

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Chrome not found. Edit CHROME path in this bat.
  pause
  exit /b 1
)

echo Opening %TARGET_URL% every ~3 seconds. Ctrl+C to stop.
echo.

start "" "%CHROME%" "%TARGET_URL%"

:loop
ping 127.0.0.1 -n 4 >nul
start "" "%CHROME%" --new-tab "%TARGET_URL%"
goto loop
