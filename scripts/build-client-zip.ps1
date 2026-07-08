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
$include = @(
  'main.js', 'preload.js',
  'setup.html', 'waiting.html', 'player.html',
  'package.json',
  'install.bat', 'start.bat', 'uninstall.bat',
  '사용설명서.txt'
)

New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $outDir  | Out-Null

foreach ($f in $include) {
  $src = Join-Path $clientDir $f
  if (Test-Path $src) {
    Copy-Item $src -Destination (Join-Path $staging $f) -Force
  } else {
    Write-Warning "누락: $f (건너뜀)"
  }
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "완료: $zipPath ($size KB)"
