# Restart the GUI server on 3080 with the whale web profile.
# ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $repo
$log = Join-Path $repo 'data\gui-restart.log'
$stdout = Join-Path $repo 'data\gui-3080.log'
$verify = Join-Path $repo 'data\gui-restart-verify.json'
$cfgPath = Join-Path $repo 'config.json'
$waitBeforeStop = 15

function Write-Log([string]$msg) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Out-File -FilePath $log -Append -Encoding UTF8
}

Write-Log 'restart scheduled'
Start-Sleep -Seconds $waitBeforeStop

$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  Write-Log ('stopping pid ' + $c.OwningProcess)
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

try {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:DEEPSEEK_API_KEY = $cfg.deepseek.apiKey
} catch {
  Write-Log 'cannot read api key'
}

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('dsh --profile web --port 3080 --no-open > "' + $stdout + '" 2>&1') -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 20

# A GUI restart can take the watchdog with it; make the control plane recover immediately.
$startAll = Join-Path $repo 'tools\start-all.ps1'
if (Test-Path $startAll) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startAll -Quiet 2>&1 | Out-Null
}

$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$http = ''
try { $http = (& curl.exe -s -o NUL -w '%{http_code}' 'http://127.0.0.1:3080/' 2>$null) } catch { $http = 'error' }
$text = Get-Content $stdout -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
$url = ''
$m = [regex]::Match($text, 'http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_\-]+')
if ($m.Success) { $url = $m.Value }
$watchdog = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'adapter-watchdog\.ps1' } | Select-Object -First 1

$result = [ordered]@{
  at = (Get-Date).ToString('o')
  up = [bool]$listener
  pid = $(if ($listener) { $listener.OwningProcess } else { 0 })
  http = $http
  watchdog = [bool]$watchdog
  watchdogPid = $(if ($watchdog) { $watchdog.ProcessId } else { 0 })
  url = $url
  logTail = (($text -split "`r?`n") | Select-Object -Last 8) -join "`n"
}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $verify -Encoding UTF8
Write-Log ('restart done up=' + $result.up + ' http=' + $http + ' watchdog=' + $result.watchdog)
if ($url) { Start-Process $url }
