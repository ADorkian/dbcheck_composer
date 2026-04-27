@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "PORT=8095"
set "URL=http://localhost:%PORT%"
set "PORT_PID="
set "PORT_PROC="
set "TMP_FILE=%TEMP%\dbcheck-composer-%RANDOM%-%RANDOM%.tmp"

cd /d "%ROOT%"

if not exist node_modules (
  echo [DbCheck Composer] node_modules missing. Installing dependencies...
  call npm install --registry=https://registry.npmjs.org/ --no-audit --no-fund --progress=false
  if errorlevel 1 (
    echo [DbCheck Composer] npm install failed.
    exit /b 1
  )
)

powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c[0].OwningProcess }" > "%TMP_FILE%" 2>nul
set /p PORT_PID=<"%TMP_FILE%" 2>nul
del "%TMP_FILE%" >nul 2>nul

if defined PORT_PID (
  powershell -NoProfile -Command "$p = Get-Process -Id %PORT_PID% -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName }" > "%TMP_FILE%" 2>nul
  set /p PORT_PROC=<"%TMP_FILE%" 2>nul
  del "%TMP_FILE%" >nul 2>nul

  if /I "!PORT_PROC!"=="node" (
    echo [DbCheck Composer] Port %PORT% in use by node PID %PORT_PID%. Restarting it...
    taskkill /PID %PORT_PID% /F >nul 2>nul
    timeout /t 1 /nobreak >nul
  ) else (
    if not defined PORT_PROC set "PORT_PROC=unknown"
    echo [DbCheck Composer] Port %PORT% already in use by !PORT_PROC! PID %PORT_PID%.
    echo [DbCheck Composer] Stop that process first.
    exit /b 1
  )
)

echo [DbCheck Composer] Starting on %URL%
start "DbCheck Composer" cmd /k "cd /d ""%ROOT%"" && npm run dev -- --host 0.0.0.0 --port %PORT% --strictPort"

echo [DbCheck Composer] Waiting for server...
set /a WAIT=0
:waitloop
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port %PORT% -InformationLevel Quiet) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 goto openbrowser
set /a WAIT+=1
if !WAIT! GEQ 60 (
  echo [DbCheck Composer] Server not reachable on %PORT% after 30 seconds.
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto waitloop

:openbrowser
start "" "%URL%"
echo [DbCheck Composer] Browser opened at %URL%
del "%TMP_FILE%" >nul 2>nul
endlocal
