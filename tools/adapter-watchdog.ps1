$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'data\adapter-watchdog.log'
Set-Location $root

# Only one watchdog may run; duplicates would race adapter/bridge restarts.
$mutex = New-Object System.Threading.Mutex($false, 'Global\WhaleAdapterWatchdog')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Find-Bridge {
  $py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*examples\wechatauto_bridge.py*' } | Select-Object -First 1
  if ($py) { return $py }
  return Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'cmd\.exe.*\/c.*run-bridge\.bat' } | Select-Object -First 1
}

function Find-Adapter {
  $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh[\\/]+lib[\\/]+bin\.js"?\s+--profile\s+whale-agent' } | Select-Object -First 1
  if ($node) { return $node }
  return Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'cmd\.exe.*\/c\s+dsh\s+--profile\s+whale-agent' } | Select-Object -First 1
}

$tick = 0
while ($true) {
  $tick++
  if (($tick % 5) -eq 0) {
    Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 's') + '] watchdog tick') -Encoding UTF8
  }
  $ok = $false
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:8788/wechat/ping' -UseBasicParsing -TimeoutSec 5
    $ok = ($r.StatusCode -eq 200)
  } catch {
    $ok = $false
  }

  if (-not $ok) {
    $existing = Find-Adapter
    if ($existing) {
      Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 's') + '] adapter not ready, process ' + $existing.ProcessId + ' exists') -Encoding UTF8
    } else {
      $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      $env:DEEPSEEK_API_KEY = $cfg.deepseek.apiKey
      $out = Join-Path $root 'data\adapter-stdout.log'
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('dsh --profile whale-agent >> "' + $out + '" 2>&1') -WindowStyle Hidden
      Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 's') + '] adapter down, restarted') -Encoding UTF8
      Start-Sleep -Seconds 20
    }
  }

  $bridge = Find-Bridge
  if (-not $bridge) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $root 'tools\run-bridge.bat') + '"') -WindowStyle Hidden
    Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 's') + '] bridge down, restarted') -Encoding UTF8
  }

  $mem = Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue
  if (-not $mem) {
    $memCmd = 'set MEMORY_WORKERS=1&& node tools\memory-server.js >> "' + (Join-Path $root 'data\memory-server.log') + '" 2>&1'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $memCmd -WorkingDirectory $root -WindowStyle Hidden
    Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 's') + '] memory server down, restarted') -Encoding UTF8
  }

  Start-Sleep -Seconds 60
}
