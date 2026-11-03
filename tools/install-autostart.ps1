param(
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$taskName = 'WhaleBotMaintenance'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'tools\start-all.ps1'
$vbs = Join-Path $root 'tools\start-all-hidden.vbs'
$backupDir = Join-Path $root 'data\task-backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($Uninstall) {
  & schtasks.exe /Delete /TN $taskName /F 2>&1 | Out-Host
  Write-Output 'WhaleBotMaintenance removed'
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
try {
  $old = & schtasks.exe /Query /TN $taskName /XML 2>$null
  if ($LASTEXITCODE -eq 0 -and $old) {
    $old | Set-Content (Join-Path $backupDir ($taskName + '-' + $stamp + '.xml')) -Encoding UTF8
    Write-Output ('backup existing task: ' + (Join-Path $backupDir ($taskName + '-' + $stamp + '.xml')))
  }
} catch { }

# Every 5 minutes, as the current interactive user, run the idempotent launcher.
# /IT keeps it in the logged-on desktop session where WeChat UIA can work.
if (-not (Test-Path -LiteralPath $vbs)) { throw ('hidden launcher missing: ' + $vbs) }
$tr = 'wscript.exe "' + $vbs + '"'
& schtasks.exe /Create /TN $taskName /TR $tr /SC MINUTE /MO 5 /IT /RL LIMITED /F 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'schtasks create failed' }
Write-Output 'WhaleBotMaintenance installed: every 5 minutes'
& schtasks.exe /Query /TN $taskName /FO LIST 2>&1 | Select-Object -First 12 | Out-Host
