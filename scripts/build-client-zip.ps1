# 디지털 게시판 Electron 클라이언트 배포 zip 빌드 스크립트
# 사용법: PowerShell 에서  powershell -ExecutionPolicy Bypass -File scripts\build-client-zip.ps1
#
# node_modules / cache / config.json / credentials 는 제외하고,
# 설치에 필요한 소스와 배치 파일만 묶어 host/public/downloads/signage-client.zip 로 출력한다.
# (Railway 는 host/ 만 배포하므로 zip 을 host/public 아래 두어야 웹에서 다운로드된다.)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $root 'client'
$outDir    = Join-Path $root 'host\public\downloads'
$zipPath   = Join-Path $outDir 'signage-client.zip'
$staging   = Join-Path $env:TEMP ('signage-client-' + [guid]::NewGuid().ToString('N'))

# 배포에 포함할 파일 (화이트리스트 — 실수로 민감/불필요 파일 포함 방지)
# 한글 파일명(사용설명서.txt)은 이 스크립트의 인코딩에 따라 직접 매칭이 깨질 수 있으므로
# 아래 $includePatterns 의 와일드카드로 포함한다.
$include = @(
  'main.js', 'preload.js', 'live-delivery.js', 'supervisor-health.js',
  'updater.js', 'bootstrap.ps1', 'extract.ps1', 'runtime.json',
  'setup.html', 'waiting.html', 'player.html',
  'package.json', 'package-lock.json',
  'install.bat', 'start.bat', 'uninstall.bat'
)
$includePatterns = @('*.txt')

New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $outDir  | Out-Null
Copy-Item -LiteralPath (Join-Path $clientDir 'live-delivery.js') -Destination (Join-Path $root 'host\public\live-delivery.js') -Force

foreach ($f in $include) {
  $src = Join-Path $clientDir $f
  if (Test-Path $src) {
    Copy-Item $src -Destination (Join-Path $staging $f) -Force
  } else {
    throw "Missing required release file: $f"
  }
}

foreach ($pat in $includePatterns) {
  $matched = Get-ChildItem -Path $clientDir -Filter $pat -File
  if (-not $matched) { Write-Warning "패턴 일치 없음: $pat" }
  foreach ($m in $matched) {
    Copy-Item $m.FullName -Destination (Join-Path $staging $m.Name) -Force
    Write-Host "포함: $($m.Name)"
  }
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
$resolvedStaging = [System.IO.Path]::GetFullPath($staging)
$resolvedTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if (-not $resolvedStaging.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging path is outside TEMP' }
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "완료: $zipPath ($size KB)"

# Publish the immutable package before the manifest. Clients verify both length and SHA-256.
$clientPackage = Get-Content -LiteralPath (Join-Path $clientDir 'package.json') -Raw | ConvertFrom-Json
$hostPackage = Get-Content -LiteralPath (Join-Path $root 'host\package.json') -Raw | ConvertFrom-Json
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$releaseDir = Join-Path $outDir 'releases'
$manifestDir = Join-Path $root 'host\public\updates'
New-Item -ItemType Directory -Force -Path $releaseDir, $manifestDir | Out-Null
$releaseName = 'signage-client-' + $clientPackage.version + '-' + $hash.Substring(0, 16) + '.zip'
Copy-Item -LiteralPath $zipPath -Destination (Join-Path $releaseDir $releaseName) -Force
$manifest = [ordered]@{
  schema = 1
  minUpdaterSchema = 1
  minNodeMajor = 22
  version = $clientPackage.version
  serverVersion = $hostPackage.version
  url = '/downloads/releases/' + $releaseName
  sha256 = $hash
  size = (Get-Item -LiteralPath $zipPath).Length
  publishedAt = [DateTime]::UtcNow.ToString('o')
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $manifestDir 'client.json'), ($manifest | ConvertTo-Json), $utf8)
Write-Host "Update manifest: $($clientPackage.version) / $hash"
