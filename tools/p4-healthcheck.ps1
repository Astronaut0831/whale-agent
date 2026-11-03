$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$profile = Join-Path $profilesRoot 'web\cordis.patch.yml'
$checks = @()

function Add-Check($name, $ok, $detail) {
  $script:checks += [pscustomobject]@{ name = $name; ok = [bool]$ok; detail = [string]$detail }
}

$c = Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -First 1
Add-Check 'gui-3080' ([bool]$c) $(if ($c) { 'pid=' + $c.OwningProcess } else { 'down' })
$c = Get-NetTCPConnection -LocalPort 8788 -State Listen | Select-Object -First 1
Add-Check 'adapter-8788' ([bool]$c) $(if ($c) { 'pid=' + $c.OwningProcess } else { 'down' })
$c = Get-NetTCPConnection -LocalPort 8791 -State Listen | Select-Object -First 1
Add-Check 'memory-8791' ([bool]$c) $(if ($c) { 'pid=' + $c.OwningProcess } else { 'down' })

try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8788/healthz' -UseBasicParsing -TimeoutSec 5
  Add-Check 'adapter-health' ($r.StatusCode -eq 200) ('http=' + $r.StatusCode)
} catch { Add-Check 'adapter-health' $false $_.Exception.Message }

$bridge = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*wechatauto_bridge*' }
Add-Check 'bridge' ([bool]$bridge) $(if ($bridge) { 'pid=' + $bridge.ProcessId } else { 'down' })
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '-File\s+.*adapter-watchdog\.ps1' }
Add-Check 'watchdog' ([bool]$wd) $(if ($wd) { 'pid=' + $wd.ProcessId } else { 'down' })

$profileText = Get-Content -LiteralPath $profile -Raw -Encoding UTF8
Add-Check 'no-fixed-session-plugin' (-not ($profileText -match 'whale-fixed-session')) ''
Add-Check 'no-gui-input-plugin' (-not ($profileText -match 'whale-gui-input')) ''

$runtimePath = Join-Path $root 'data\runtime.json'
$runtimeTarget = ''
try { $runtimeTarget = [string]((Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json).guiSessionId) } catch { $runtimeTarget = '' }
Add-Check 'runtime-target' ([bool]$runtimeTarget) $(if ($runtimeTarget) { 'guiSessionId present' } else { 'missing data/runtime.json target' })

$sessionRoot = if ($env:WHALE_SESSION_DIR) { $env:WHALE_SESSION_DIR } else { Join-Path $env:USERPROFILE '.dsh\sessions\--D-dsh-workspace-chat--' }
$activeSession = ''
if (-not (Test-Path -LiteralPath $sessionRoot)) {
  Add-Check 'runtime-target-active' $true "skipped: session dir not found ($sessionRoot)"
} else {
  try {
    $activeSession = Get-ChildItem -LiteralPath $sessionRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        $f = Join-Path $_.FullName 'session.v4.jsonl.zstd'
        if (Test-Path -LiteralPath $f) { [pscustomobject]@{ Name = $_.Name; Mtime = (Get-Item -LiteralPath $f).LastWriteTime } }
      } |
      Sort-Object Mtime -Descending |
      Select-Object -First 1 -ExpandProperty Name
  } catch { $activeSession = '' }
  $targetSessionFile = Join-Path $sessionRoot (Join-Path $runtimeTarget 'session.v4.jsonl.zstd')
  $targetExists = [bool]($runtimeTarget -and (Test-Path -LiteralPath $targetSessionFile))
  Add-Check 'runtime-target-active' $targetExists "target=$runtimeTarget exists=$targetExists newest=$activeSession"
}

$headlessProfile = Join-Path $profilesRoot 'whale-headless\cordis.patch.yml'
$taskProfile = Join-Path $profilesRoot 'whale-headless-task\cordis.patch.yml'
$headlessText = Get-Content -LiteralPath $headlessProfile -Raw -Encoding UTF8
$taskText = Get-Content -LiteralPath $taskProfile -Raw -Encoding UTF8
Add-Check 'headless-fs-disabled' ($headlessText -match '(?s)- id: tool-fs\r?\n  disabled: true') ''
Add-Check 'task-fs-not-disabled' ($taskText -notmatch '(?s)- id: tool-fs\r?\n  disabled: true') ''
Add-Check 'headless-system-context' ($headlessText -match 'whale-system-context') ''
Add-Check 'task-system-context' ($taskText -match 'whale-system-context') ''

$task = & schtasks.exe /Query /TN 'WhaleBotMaintenance' /FO LIST 2>&1
Add-Check 'maintenance-task' (($task -join "`n") -match 'Ready|就绪') (($task | Select-String -Pattern 'Status|Next Run').Line -join '; ')

$backupTask = & schtasks.exe /Query /TN 'WhaleMemoryBackup' /FO LIST 2>&1
Add-Check 'memory-backup-task' (($backupTask -join "`n") -match 'Ready|就绪') (($backupTask | Select-String -Pattern 'Status|Next Run').Line -join '; ')

$result = [pscustomobject]@{
  at = (Get-Date).ToString('s')
  ok = -not ($checks | Where-Object { -not $_.ok })
  checks = $checks
}
$out = Join-Path $root 'data\p4-healthcheck.json'
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $out -Encoding UTF8
$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
exit 0
