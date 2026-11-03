param(
  [Parameter(Mandatory = $true)][string]$SessionId,
  [string]$MemoryToken = '',
  [string]$GuiTokenFile = '',
  [string]$Workspace = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root 'data\runtime.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
$state = @{}
if (Test-Path -LiteralPath $file) {
  try { $state = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable } catch { $state = @{} }
}
$state.guiSessionId = $SessionId
if ($MemoryToken) { $state.memoryToken = $MemoryToken }
if ($GuiTokenFile) { $state.guiTokenFile = $GuiTokenFile }
if ($Workspace) { $state.workspace = $Workspace }
$state.updatedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $file -Encoding UTF8
Write-Output ('runtime state written: ' + $file)
