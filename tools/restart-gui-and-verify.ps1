$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\dsh-workspace\chat'
$log = 'D:\dsh-workspace\chat\whale_gril\data\gui-input-verify.log'
$guiLog = Join-Path $env:LOCALAPPDATA 'dsh\web.log'
$cfgPath = 'D:\dsh-workspace\chat\whale_gril\config.json'

"[{0}] restart-and-verify start" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Out-File -FilePath $log -Encoding UTF8

$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  "[{0}] stopping 3080 pid {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $c.OwningProcess | Out-File -FilePath $log -Append -Encoding UTF8
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

try {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:DEEPSEEK_API_KEY = $cfg.deepseek.apiKey
} catch {
  "[{0}] cannot read api key" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Out-File -FilePath $log -Append -Encoding UTF8
}

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('dsh --profile web --port 3080 --no-open > "' + $guiLog + '" 2>&1') -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 20

$ok = $false
$hasInput = $false
$token = ''
try {
  $raw = Get-Content $guiLog -Raw -Encoding UTF8
  $m = [regex]::Match($raw, '[?&]token=([A-Za-z0-9_-]+)')
  if ($m.Success) { $token = $m.Groups[1].Value }
  if ($token) {
    $r = Invoke-WebRequest ('http://127.0.0.1:3080/?token=' + $token) -UseBasicParsing -TimeoutSec 15
    $ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    $hasInput = ($r.Content -match 'whale-gui-input')
  }
} catch {
  "[{0}] probe failed: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message | Out-File -FilePath $log -Append -Encoding UTF8
}
"[{0}] restarted http={1} gui-input-plugin={2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $ok, $hasInput | Out-File -FilePath $log -Append -Encoding UTF8
