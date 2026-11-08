<#
  Manual launcher for the Whale DSH stack (no scheduled task).
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-all.ps1
  Idempotent: anything already running is left alone.
  Keep this file ASCII-only: PowerShell 5.1 misreads UTF-8 without BOM.

  Old server.js (8787) is intentionally NOT started. Use tools\run-server.bat only
  when doing a deliberate legacy rollback.
#>
param(
  [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$WeChat = if ($env:WHALE_WECHAT_EXE) { $env:WHALE_WECHAT_EXE } else { 'D:\Program Files\Tencent\Weixin\Weixin.exe' }
$Log = Join-Path $Root 'data\startup.log'
$started = 0

# A scheduled watchdog may run this concurrently with a manual launch.
$startMutex = New-Object System.Threading.Mutex($false, 'Global\WhaleStartAll')
if (-not $startMutex.WaitOne(0)) { exit 0 }

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
  if (-not $Quiet) { Write-Output $msg }
}

function Test-Port([int]$port) {
  $hit = & netstat -ano -p tcp | Select-String (":{0}\s" -f $port) | Select-String 'LISTENING' | Select-Object -First 1
  return [bool]$hit
}

function Test-Url([string]$url) {
  try {
    $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Find-Bridge {
  $py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*examples\wechatauto_bridge.py*' } | Select-Object -First 1
  if ($py) { return $py }
  # The batch wrapper also counts: it may be in its 5s restart delay.
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

# Hidden launch: wscript + VBS runs the wrapper bat with window state 0.
function Start-Wrapped([string]$bat) {
  $vbs = Join-Path $Root 'tools\hidden-run.vbs'
  $target = Join-Path $Root ("tools\" + $bat)
  $cmdLine = 'wscript.exe "{0}" "{1}"' -f $vbs, $target
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $Root }
  return [int]$r.ProcessId
}

function Get-ApiKey {
  try {
    $cfg = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$cfg.deepseek.apiKey
  } catch { return '' }
}

# 1) WeChat client
if (-not (Get-Process -Name Weixin -ErrorAction SilentlyContinue)) {
  if (Test-Path $WeChat) {
    Start-Process -FilePath $WeChat
    Write-Log 'wechat: started'
    $started++
    Start-Sleep -Seconds 8
  } else {
    Write-Log "wechat: executable not found at $WeChat"
  }
}

# 2) Embed service on :8790
if (-not (Test-Port 8790)) {
  $p = Start-Wrapped 'run-embed.bat'
  Write-Log "embed: started (pid $p)"
  $started++
  Start-Sleep -Seconds 10
}

# 3) DSH adapter on :8788
if (-not (Test-Url 'http://127.0.0.1:8788/healthz')) {
  $existing = Find-Adapter
  if ($existing) {
    Write-Log "adapter: process exists (pid $($existing.ProcessId)), waiting"
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      if (Test-Url 'http://127.0.0.1:8788/healthz') { break }
    }
  } else {
    $key = Get-ApiKey
    if ($key) {
      $env:DEEPSEEK_API_KEY = $key
      $out = Join-Path $Root 'data\adapter-stdout.log'
      $cmd = 'dsh --profile whale-agent >> "' + $out + '" 2>&1'
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $Root -WindowStyle Hidden -PassThru
      Write-Log "adapter: started (pid $($p.Id))"
      $started++
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Url 'http://127.0.0.1:8788/healthz') { break }
      }
    } else {
      Write-Log 'adapter: no deepseek api key'
    }
  }
}

# 4) Memory service on :8791
if (-not (Test-Port 8791)) {
  $out = Join-Path $Root 'data\memory-server.log'
  $cmd = 'set MEMORY_WORKERS=1&& node tools\memory-server.js >> "' + $out + '" 2>&1'
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Write-Log "memory: started (pid $($p.Id))"
  $started++
  Start-Sleep -Seconds 3
}

# 5) WeChat bridge (waits for /healthz)
if (-not (Find-Bridge)) {
  $p = Start-Wrapped 'run-bridge.bat'
  Write-Log "bridge: started (pid $p)"
  $started++
  Start-Sleep -Seconds 6
}

# 5c) Platform console on :3100
if (-not (Test-Url 'http://127.0.0.1:3100/api/status')) {
  $consoleDir = Join-Path $Root 'tools\platform-console'
  if (Test-Path (Join-Path $consoleDir 'dist\index.html')) {
    $out = Join-Path $Root 'data\platform-console.log'
    $cmd = 'node server.mjs >> "' + $out + '" 2>&1'
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $consoleDir -WindowStyle Hidden -PassThru
    Write-Log "console: started (pid $($p.Id))"
    $started++
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 1
      if (Test-Url 'http://127.0.0.1:3100/api/status') { break }
    }
  } else {
    Write-Log 'console: dist missing, run npm run build in tools/platform-console'
  }
}

# 5b) watchdog: guards adapter / memory / bridge
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*adapter-watchdog.ps1*' } | Select-Object -First 1
if (-not $wd) {
  $wdPath = Join-Path $Root 'tools\adapter-watchdog.ps1'
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$wdPath -WindowStyle Hidden
  Write-Log 'watchdog: started'
  $started++
}

# 6) Status
if ($started -gt 0 -or -not $Quiet) {
  $wechatUp = [bool](Get-Process -Name Weixin -ErrorAction SilentlyContinue)
  $embedUp = Test-Port 8790
  $bridgeUp = [bool](Find-Bridge)
  $adapterUp = Test-Url 'http://127.0.0.1:8788/healthz'
  $memoryUp = Test-Port 8791
  # Old 8787 is retired: never probe it in the normal launcher.
  $legacyUp = $false
  $consoleUp = Test-Url 'http://127.0.0.1:3100/api/status'
  Write-Log ("status wechat={0} embed={1} adapter={2} memory={3} bridge={4} console={5} legacy={6}" -f $wechatUp, $embedUp, $adapterUp, $memoryUp, $bridgeUp, $consoleUp, $legacyUp)
}
