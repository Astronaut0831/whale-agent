$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\dsh-workspace\chat\whale_gril'
Set-Location $root

# 1. adapter mode -> off
node tools\core-mode.js off | Out-Host

# 2. stop watchdog first: it would otherwise restart adapter/memory immediately
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*adapter-watchdog.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 3. stop DSH adapter and memory service (legacy becomes the only memory writer)
foreach ($port in @(8788, 8791)) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# 4. remove WHALE_BOT_URL from bridge launcher (backup first)
$bat = Join-Path $root 'tools\run-bridge.bat'
if (Test-Path $bat) {
  Copy-Item $bat ($bat + '.bak-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
  $lines = Get-Content $bat -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*set\s+WHALE_BOT_URL=' }
  Set-Content $bat $lines -Encoding ASCII
}

# 5. start legacy server on 8787
$legacy = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $legacy) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $root 'tools\run-server.bat') + '"') -WindowStyle Hidden
  Start-Sleep -Seconds 8
}

# 6. restart bridge (it now points at 8787)
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*wechatauto_bridge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run-bridge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $bat + '"') -WindowStyle Hidden
Start-Sleep -Seconds 12

# 7. report
Get-Content (Join-Path $root 'data\wechat-bridge-4x.log') -Tail 8 -Encoding UTF8 | Out-Host
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8787/' -UseBasicParsing -TimeoutSec 5
  Write-Host ('legacy bot HTTP ' + $r.StatusCode)
} catch {
  Write-Host 'legacy bot unreachable'
}
Write-Host 'legacy rollback complete: adapter/memory/watchdog stopped; bridge -> 8787'
