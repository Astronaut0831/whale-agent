# Restart the GUI server on 3080 with the whale web profile.
# ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\dsh-workspace\chat'
$log = 'D:\dsh-workspace\chat\whale_gril\data\gui-restart.log'
$cfgPath = 'D:\dsh-workspace\chat\whale_gril\config.json'

"[{0}] restart scheduled" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Out-File -FilePath $log -Encoding UTF8
Start-Sleep -Seconds 15

$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  "[{0}] stopping pid {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $c.OwningProcess | Out-File -FilePath $log -Append -Encoding UTF8
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

try {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:DEEPSEEK_API_KEY = $cfg.deepseek.apiKey
} catch {
  "[{0}] cannot read api key" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Out-File -FilePath $log -Append -Encoding UTF8
}

$stdout = 'D:\dsh-workspace\chat\whale_gril\data\gui-3080.log'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('dsh --profile web --port 3080 --no-open > "' + $stdout + '" 2>&1') -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 15

$ok = $false
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 8
  $ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
} catch {
  $ok = $false
}
"[{0}] restarted health={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $ok | Out-File -FilePath $log -Append -Encoding UTF8
