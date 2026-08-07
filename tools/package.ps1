# Package the game into the structure required by the Bilibili "toy" platform:
#   zombie-world.zip
#     index.html  (required entry)
#     style.css
#     script.js
#     multiplayer.js
#     images/  (logo.png, banner.jpg)
# Usage:  powershell -ExecutionPolicy Bypass -File tools\package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$items = @('index.html', 'style.css', 'script.js', 'multiplayer.js', 'images')
foreach ($i in $items) {
  if (-not (Test-Path $i)) { throw "Missing required item: $i" }
}

$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir 'zombie-world.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

Compress-Archive -Path $items -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Built: $zip"
Write-Host ("Size : {0} KB" -f [math]::Round((Get-Item $zip).Length / 1KB, 1))
Write-Host "--- contents ---"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$archive.Entries | ForEach-Object { Write-Host ("  " + $_.FullName) }
$archive.Dispose()
