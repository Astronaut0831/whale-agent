param(
  [switch]$On
)
$ErrorActionPreference = 'Stop'
$file = 'C:\Users\astronaut\.dsh\profiles\whale-agent\cordis.patch.yml'
$bak = $file + '.bak-guiBroker-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $file -Destination $bak -Force

$lines = Get-Content -LiteralPath $file -Encoding UTF8
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i].Trim() -eq 'guiBroker:') { $start = $i; break }
}
if ($start -lt 0) { throw 'guiBroker block not found; restore ' + $bak }
$changed = $false
for ($i = $start + 1; $i -lt [Math]::Min($start + 8, $lines.Count); $i++) {
  if ($lines[$i].Trim() -match '^enabled:\s*(true|false)$') {
    $indent = $lines[$i].Substring(0, $lines[$i].Length - $lines[$i].TrimStart().Length)
    $value = if ($On) { 'true' } else { 'false' }
    $lines[$i] = $indent + 'enabled: ' + $value
    $changed = $true
    break
  }
}
if (-not $changed) { throw 'guiBroker.enabled not found; restore ' + $bak }
[System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('guiBroker.enabled=' + ($(if ($On) {'true'} else {'false'})) + ' backup=' + $bak)
Write-Output 'restart whale-agent adapter to apply'
