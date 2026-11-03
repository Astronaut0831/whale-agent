param(
  [string]$Out = 'dist\whale-girl-source.zip'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('whale-src-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  Push-Location $root
  $prefix = $tmp.Replace('\', '/') + '/'
  git checkout-index -a --prefix=$prefix
  Pop-Location
  Remove-Item (Join-Path $tmp 'config.json') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $tmp 'data') -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path (Split-Path -Parent $outPath) -Force | Out-Null
  Remove-Item $outPath -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $outPath -CompressionLevel Optimal
  Write-Output $outPath
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
