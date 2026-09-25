# Stable Windows entry point. Do not depend on npm or an already installed Node.
param([string]$InstallRoot = $PSScriptRoot, [switch]$NoStartupRegistration, [switch]$ForcePortableRuntime)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$stateRoot = Join-Path $InstallRoot '.signage'
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null
$logPath = Join-Path $stateRoot 'bootstrap.log'
function Log($message) { [IO.File]::AppendAllText($logPath, "$(Get-Date -Format o) $message`r`n") }
$digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($InstallRoot.ToLowerInvariant()))
$key = [BitConverter]::ToString($digest).Replace('-', '').Substring(0, 24)
$mutex = New-Object Threading.Mutex($false, "Local\Signage-$key")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { exit 0 }
  $bundleRoot = $InstallRoot
  try {
    $state = Get-Content -LiteralPath (Join-Path $stateRoot 'state.json') -Raw | ConvertFrom-Json
    if ($state.active.dir -and $state.active.dir -ne '.') {
      $active = [IO.Path]::GetFullPath((Join-Path $InstallRoot $state.active.dir))
      $allowed = [IO.Path]::GetFullPath((Join-Path $stateRoot 'releases')).TrimEnd('\') + '\'
      if ($active.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath (Join-Path $active 'updater.js'))) { $bundleRoot = $active }
    }
  } catch { }
  if (-not $NoStartupRegistration) {
    try {
      $startup = [Environment]::GetFolderPath('Startup')
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut((Join-Path $startup 'DigitalSignage.lnk'))
      $shortcut.TargetPath = Join-Path $InstallRoot 'start.bat'
      $shortcut.WorkingDirectory = $InstallRoot
      $shortcut.WindowStyle = 7
      $shortcut.Save()
    } catch { Log "Startup registration failed: $_" }
  }
  $node = $null
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and -not $ForcePortableRuntime) {
    $version = & $systemNode.Source --version
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $node = $systemNode.Source }
  }
  if (-not $node) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $runtime = Get-Content -LiteralPath (Join-Path $bundleRoot 'runtime.json') -Raw | ConvertFrom-Json
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $runtimeRoot = Join-Path $stateRoot ('runtime\node-v' + $runtime.version + '-win-' + $arch)
    $node = Join-Path $runtimeRoot 'node.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'complete.json')) -or -not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node_modules\npm\bin\npm-cli.js'))) {
      $package = $runtime.('win32-' + $arch)
      $zipPath = Join-Path $stateRoot ('node-' + [guid]::NewGuid().ToString('N') + '.zip')
      Log 'Installing verified portable Node runtime'
      Invoke-WebRequest -UseBasicParsing -Uri $package.url -OutFile $zipPath -TimeoutSec 120
      if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.sha256) { throw 'Node checksum mismatch' }
      $runtimeStage = Join-Path $stateRoot ('runtime-stage-' + [guid]::NewGuid().ToString('N'))
      & (Join-Path $bundleRoot 'extract.ps1') -Archive $zipPath -Destination $runtimeStage -MaxBytes 400000000
      $extracted = Join-Path $runtimeStage ('node-v' + $runtime.version + '-win-' + $arch)
      if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node_modules\npm\bin\npm-cli.js'))) { throw 'Portable npm is missing' }
      if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe'))) { throw 'Portable Node is missing' }
      [IO.Directory]::CreateDirectory((Join-Path $stateRoot 'runtime')) | Out-Null
      $safePrefix = [IO.Path]::GetFullPath($stateRoot).TrimEnd('\') + '\'
      foreach ($targetPath in @($extracted, $runtimeRoot)) {
        if (-not [IO.Path]::GetFullPath($targetPath).StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime path' }
      }
      if (Test-Path -LiteralPath $runtimeRoot) { [IO.Directory]::Move($runtimeRoot, $runtimeRoot + '.incomplete-' + [guid]::NewGuid().ToString('N')) }
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { [IO.Directory]::Move($extracted, $runtimeRoot); break }
        catch { if ($attempt -eq 19) { throw }; Start-Sleep -Milliseconds 500 }
      }
      # Execute only after moving: Windows can temporarily lock an executable's
      # directory after process exit, which otherwise breaks the commit step.
      & $node --version | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Portable Node did not start' }
      [IO.File]::WriteAllText((Join-Path $runtimeRoot 'complete.json'), '{"complete":true}')
      Remove-Item -LiteralPath $zipPath -Force
    }
  }
  $updater = Join-Path $bundleRoot 'updater.js'
  do {
    Log 'Starting update supervisor'
    & $node $updater --root $InstallRoot
    $supervisorCode = $LASTEXITCODE
    if ($supervisorCode -ne 0) {
      Log 'Supervisor failed; retrying with the bundled recovery supervisor'
      $updater = Join-Path $InstallRoot 'updater.js'
      Start-Sleep -Seconds 15
    }
  } while ($supervisorCode -ne 0)
  exit 0
} catch {
  Log "Bootstrap failed: $_"
  $legacy = Join-Path $InstallRoot 'node_modules\electron\dist\electron.exe'
  if (Test-Path -LiteralPath $legacy) {
    Start-Process -FilePath $legacy -ArgumentList ('"' + $InstallRoot + '"') -WorkingDirectory $InstallRoot -WindowStyle Hidden
  }
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
