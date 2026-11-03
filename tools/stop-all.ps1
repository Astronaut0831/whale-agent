<#
  Manual shutdown for the Whale Bot stack.
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-all.ps1
    powershell ... -File tools\stop-all.ps1 -IncludeWeChat   # also close WeChat
  Only touches our own processes (matched by port / command line); the rest of the system is untouched.
#>
param(
  [switch]$IncludeWeChat
)

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$Log = Join-Path $Root 'data\startup.log'
$stopped = 0

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
  Write-Output $msg
}

function Get-PortOwner([int]$port) {
  $line = & netstat -ano -p tcp | Select-String (":{0}\s" -f $port) | Select-String 'LISTENING' | Select-Object -First 1
  if (-not $line) { return 0 }
  $parts = ($line.ToString() -split '\s+') | Where-Object { $_ -ne '' }
  return [int]$parts[-1]
}

function Stop-Server {
  $ownerPid = Get-PortOwner 8787
  if ($ownerPid -gt 0) {
    Stop-Process -Id $ownerPid -Force
    Write-Log "server: stopped (pid $ownerPid)"
    $script:stopped++
  } else {
    Write-Log 'server: not running'
  }
}

function Stop-ByPattern([string]$pattern, [string]$label) {
  # python only: node.exe matching used to catch unrelated processes whose command line merely mentioned the script
  $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$pattern*" }
  if (-not $procs) {
    Write-Log "${label}: not running"
    return
  }
  foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Log "${label}: stopped (pid $($p.ProcessId))"
    $script:stopped++
  }
}

Stop-Server
Stop-ByPattern 'examples\wechatauto_bridge.py' 'bridge'
Stop-ByPattern 'examples\embed_server.py' 'embed'

if ($IncludeWeChat) {
  $wx = Get-Process -Name Weixin -ErrorAction SilentlyContinue
  if ($wx) {
    $wx | Stop-Process -Force
    Write-Log 'wechat: closed'
    $stopped++
  } else {
    Write-Log 'wechat: not running'
  }
}

Start-Sleep -Seconds 2
$left = @()
if ((Get-PortOwner 8787) -gt 0) { $left += '8787' }
if ((Get-PortOwner 8790) -gt 0) { $left += '8790' }
if ($left.Count -eq 0) {
  Write-Log "done: all services stopped ($stopped processes)"
} else {
  Write-Log ("warning: ports still listening -> " + ($left -join ', '))
}
