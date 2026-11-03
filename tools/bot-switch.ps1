param([ValidateSet('on', 'off', 'status', 'toggle')][string]$Action = 'toggle')
$ErrorActionPreference = 'Stop'
$file = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\bot-online.json'
$current = $true
try {
  $d = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  $current = $d.online -ne $false
} catch { $current = $true }

if ($Action -eq 'status') {
  Write-Output ($(if ($current) { 'online' } else { 'offline' }))
  exit 0
}
if ($Action -eq 'toggle') { $next = -not $current }
else { $next = ($Action -eq 'on') }

New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
@{ online = [bool]$next; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $file -Encoding UTF8
Write-Output ($(if ($next) { 'online' } else { 'offline' }))
