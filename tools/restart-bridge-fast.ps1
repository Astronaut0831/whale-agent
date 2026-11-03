$ErrorActionPreference='SilentlyContinue'
Start-Sleep -Seconds 8
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*wechatauto_bridge.py*' } | Select-Object -First 1
if ($py) { Stop-Process -Id $py.ProcessId -Force }