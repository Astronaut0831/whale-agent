# Re-apply the whale memory hooks to the installed @tencent-connect/dsh-qqbot.
# The package manager may overwrite node_modules on update; run this afterwards.
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@tencent-connect\dsh-qqbot\lib'
$session = Join-Path $base 'session\session-manager.js'
$bootstrap = Join-Path $base 'gateway\bootstrap.js'
if (-not (Test-Path $session) -or -not (Test-Path $bootstrap)) {
  throw "dsh-qqbot not found under $base"
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Patch-File([string]$path, [string]$old, [string]$new, [string]$marker) {
  $text = [IO.File]::ReadAllText($path)
  if ($text.Contains($marker)) { Write-Output "already patched: $path"; return }
  if (-not $text.Contains($old)) { throw "patch target not found: $path" }
  Copy-Item $path "$path.bak-whale-$stamp" -Force
  [IO.File]::WriteAllText($path, $text.Replace($old, $new), (New-Object Text.UTF8Encoding($false)))
  Write-Output "patched: $path"
}

$oldSession = @'
        this.sessions.set(key, record);
        return record;
'@
$newSession = @'
        this.sessions.set(key, record);
        try { this.ctx.emit?.('qqbot/session-ready', { record }); } catch { /* whale hook */ }
        return record;
'@
Patch-File $session $oldSession $newSession 'qqbot/session-ready'

$oldBootstrap = @'
        await handleInbound(mCtx, manager, config, logger);
'@
$newBootstrap = @'
        await handleInbound(mCtx, manager, config, logger);
        try { ctx.emit?.('qqbot/inbound', { msg, mCtx }); } catch { /* whale hook */ }
'@
Patch-File $bootstrap $oldBootstrap $newBootstrap 'qqbot/inbound'
