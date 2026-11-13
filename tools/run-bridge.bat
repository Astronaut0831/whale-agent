@echo off
setlocal
cd /d "%~dp0.."
if not exist "data" mkdir "data"
if exist "data\bridge-stop.flag" (
  echo [%date% %time%] bridge stopped by flag (pre-start) >> "data\bridge-restart.log"
  goto :eof
)
set "WHALE_BOT_URL=http://127.0.0.1:8788/webhook/wechat"
set "PYTHON=%WHALE_PYTHON%"
if not defined PYTHON set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PYTHON%" (
  where py >nul 2>&1 && (set "PYTHON=py -3") || (set "PYTHON=python")
)
:loop
%PYTHON% examples\wechatauto_bridge.py >> "data\bridge-stdout.log" 2>&1
if exist "data\bridge-stop.flag" (
  echo [%date% %time%] bridge stopped by flag >> "data\bridge-restart.log"
  goto :eof
)
echo [%date% %time%] bridge exit %errorlevel%, restarting in 5s >> "data\bridge-restart.log"
timeout /t 5 /nobreak >nul
goto loop
