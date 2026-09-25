param([Parameter(Mandatory=$true)][string]$Archive,
      [Parameter(Mandatory=$true)][string]$Destination,
      [long]$MaxBytes = 50000000)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
[IO.Directory]::CreateDirectory($target) | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  if ($zip.Entries.Count -gt 10000) { throw 'Too many ZIP entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    $parts = $name.Split('\')
    if ($name.StartsWith('\') -or $name.Contains(':') -or $parts -contains '..' -or $parts -contains '.') { throw "Unsafe ZIP path: $name" }
    foreach ($part in $parts) {
      if ($part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') { throw "Unsafe ZIP name: $name" }
    }
    $kind = ($entry.ExternalAttributes -shr 16) -band 61440
    if ($kind -eq 40960) { throw 'ZIP links are not allowed' }
    $path = [IO.Path]::GetFullPath((Join-Path $target $name))
    if (-not $path.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path escaped destination' }
    if (-not $seen.Add($path)) { throw "Duplicate ZIP entry: $name" }
    $total += $entry.Length
    if ($total -gt $MaxBytes) { throw 'ZIP exceeds extraction limit' }
    if ($name.EndsWith('\')) { [IO.Directory]::CreateDirectory($path) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $false)
  }
} finally { $zip.Dispose() }
