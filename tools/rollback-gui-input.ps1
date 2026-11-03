# Disable the GUI input broker wrapper by removing its profile insert.
# The backup is written before every change; restart the GUI afterwards.
$ErrorActionPreference = 'Stop'
$file = 'C:\Users\astronaut\.dsh\profiles\web\cordis.patch.yml'
$bak = $file + '.bak-guiinput-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $file -Destination $bak -Force
$text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
$pattern = '(?ms)^- insert:\r?\n    - id: whale-gui-input\r?\n      name: "@whale/whale-gui-input"\r?\n?'
$next = [regex]::Replace($text, $pattern, '')
if ($next -eq $text) { throw 'whale-gui-input insert not found; restore ' + $bak }
[System.IO.File]::WriteAllText($file, $next, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('whale-gui-input disabled; backup=' + $bak)
Write-Output 'restart the GUI to apply'
