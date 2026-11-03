$ErrorActionPreference='SilentlyContinue'
Start-Sleep -Seconds 20
$root = Split-Path -Parent $PSScriptRoot
$ad = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'lib[\\/]+bin\.js"?\s+--profile\s+whale-agent' } | Select-Object -First 1
if ($ad) { Stop-Process -Id $ad.ProcessId -Force; Start-Sleep -Seconds 5 }
$cfg=Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$env:DEEPSEEK_API_KEY=$cfg.deepseek.apiKey
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',('dsh --profile whale-agent >> "'+(Join-Path $root 'data\adapter-stdout.log')+'" 2>&1') -WorkingDirectory $root -WindowStyle Hidden