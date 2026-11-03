<#
  Read-only health check for the Whale Bot stack. Starts nothing, kills nothing.
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-status.ps1
#>
$ErrorActionPreference = 'SilentlyContinue'

function Test-Port([int]$port) {
  $hit = & netstat -ano -p tcp | Select-String (":{0}\s" -f $port) | Select-String 'LISTENING' | Select-Object -First 1
  return [bool]$hit
}

$wechat = Get-Process -Name Weixin -ErrorAction SilentlyContinue
$wechatWin = $wechat | Where-Object { $_.MainWindowHandle -ne 0 }
$embed = Test-Port 8790
$server = Test-Port 8787
$bridgeProc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*wechatauto_bridge*' } | Select-Object -First 1

$lines = @()
$lines += 'WeChat process : ' + $(if ($wechat) { 'running' } else { 'NOT RUNNING' })
$lines += 'WeChat window  : ' + $(if ($wechatWin) { 'visible' } else { 'minimized to tray (sending will fail)' })
$lines += 'embed  :8790   : ' + $(if ($embed) { 'OK' } else { 'DOWN' })
$lines += 'server :8787   : ' + $(if ($server) { 'OK' } else { 'DOWN' })
$lines += 'bridge process : ' + $(if ($bridgeProc) { 'OK (pid ' + $bridgeProc.ProcessId + ')' } else { 'DOWN' })

$bad = ($lines -match 'NOT RUNNING|minimized|DOWN').Count
$lines += ''
$lines += $(if ($bad -eq 0) { '=> all good' } else { '=> ' + $bad + ' problem(s); double-click 启动鲸鲸.bat to repair' })

$lines | ForEach-Object { Write-Output $_ }
