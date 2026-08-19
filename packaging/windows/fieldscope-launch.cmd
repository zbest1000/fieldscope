@echo off
rem Fieldscope launcher (installed copy). Uses the bundled Node runtime, keeps
rem evidence under %LOCALAPPDATA%\Fieldscope\data, and opens the browser.
setlocal
set "DIR=%~dp0"
if not defined FIELDSCOPE_DATA set "FIELDSCOPE_DATA=%LOCALAPPDATA%\Fieldscope\data"
if not defined PORT set "PORT=5100"
set "NODE_ENV=production"
if not exist "%FIELDSCOPE_DATA%" mkdir "%FIELDSCOPE_DATA%" >nul 2>&1
start "" "http://localhost:%PORT%"
"%DIR%node.exe" "%DIR%server\index.js" %*
