@echo off
setlocal
cd /d "%~dp0.."
if not exist "data" mkdir "data"
set "PYTHON=%WHALE_PYTHON%"
if not defined PYTHON (
  where py >nul 2>&1 && (set "PYTHON=py -3") || (set "PYTHON=python")
)
%PYTHON% examples\embed_server.py 8790 >> "data\embed-stdout.log" 2>&1
