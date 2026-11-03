param([switch]$Uninstall, [string]$Time = '03:30')
$ErrorActionPreference = 'Stop'
$taskName = 'WhaleMemoryBackup'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'tools\backup-memory.ps1'
$vbs = Join-Path $root 'tools\backup-memory-hidden.vbs'
$backupDir = Join-Path $root 'data\task-backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

if ($Uninstall) {
  & schtasks.exe /Delete /TN $taskName /F 2>&1 | Out-String | Write-Output
  Write-Output ($taskName + ' uninstalled')
  exit 0
}

$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$existing = & schtasks.exe /Query /TN $taskName /XML 2>$null
$ErrorActionPreference = $oldEap
if ($LASTEXITCODE -eq 0 -and $existing) {
  $bak = Join-Path $backupDir ($taskName + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
  $existing | Set-Content -LiteralPath $bak -Encoding UTF8
  Write-Output ('existing task backed up: ' + $bak)
}

if (-not (Test-Path -LiteralPath $vbs)) { throw ('hidden launcher missing: ' + $vbs) }
$tr = 'wscript.exe "' + $vbs + '"'
& schtasks.exe /Create /TN $taskName /TR $tr /SC DAILY /ST $Time /IT /RL LIMITED /F 2>&1 | Write-Output
& schtasks.exe /Query /TN $taskName /FO LIST 2>&1 | Select-String -Pattern 'TaskName|Next Run|Status|Logon' | ForEach-Object { $_.Line }
