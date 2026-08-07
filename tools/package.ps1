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

$files  = @('index.html', 'style.css', 'script.js', 'multiplayer.js')
# images/ 只挑要进包的：poster.png 是上传平台时用 --poster 单独传的封面，
# 游戏本身不引用它，卷进包里白白多 150 KB。
$images = @('logo.png', 'banner.jpg')
foreach ($i in ($files + ($images | ForEach-Object { "images/$_" }))) {
  if (-not (Test-Path $i)) { throw "Missing required item: $i" }
}

$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir 'zombie-world.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

# 先摆进临时目录再压，才能既保留 images/ 目录结构又排除单个文件
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("zw-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  foreach ($f in $files) { Copy-Item $f -Destination $stage }
  $stageImg = Join-Path $stage 'images'
  New-Item -ItemType Directory -Force -Path $stageImg | Out-Null
  foreach ($f in $images) { Copy-Item (Join-Path 'images' $f) -Destination $stageImg }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Built: $zip"
Write-Host ("Size : {0} KB" -f [math]::Round((Get-Item $zip).Length / 1KB, 1))
Write-Host "--- contents ---"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$archive.Entries | ForEach-Object { Write-Host ("  " + $_.FullName) }
$archive.Dispose()
