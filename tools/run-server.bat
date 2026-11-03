@echo off
setlocal
cd /d "%~dp0.."
if not exist "data" mkdir "data"
node server.js >> "data\server-stdout.log" 2>&1
