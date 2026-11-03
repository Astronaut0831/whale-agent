# Daily memory snapshot via the local memory service. No restart, no session changes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cfgPath = Join-Path $root 'config.json'
$log = Join-Path $root 'data\memory-backup.log'

$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$token = $cfg.gateway.wechat.inboundToken
$base = if ($cfg.memoryUrl) { $cfg.memoryUrl } else { 'http://127.0.0.1:8791' }
$url = ($base -replace '/+$', '') + '/memory/backup'
$headers = @{ 'content-type' = 'application/json'; 'x-bot-token' = $token }

try {
  $r = Invoke-WebRequest -Uri $url -Method Post -Headers $headers -Body '{}' -UseBasicParsing -TimeoutSec 30
  $data = $r.Content | ConvertFrom-Json
  $line = '[{0}] ok={1} file={2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), [bool]$data.ok, $data.file
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
  if (-not $data.ok) { exit 1 }
} catch {
  $line = '[{0}] FAIL {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
  exit 1
}
