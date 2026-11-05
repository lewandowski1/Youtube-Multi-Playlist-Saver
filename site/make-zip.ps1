# Packs the extension twice and updates the size shown on the download page. Run it again after
# changing the extension.
#   site\playlist-multi-save.zip   the page's download: files in a folder named playlist-multi-save,
#                                 ready for "Load unpacked" after unzipping
#   store\playlist-multi-save.zip  for the Chrome Web Store, which wants manifest.json at the top
#
#   powershell -ExecutionPolicy Bypass -File site\make-zip.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$name = 'playlist-multi-save'
$root = Split-Path $PSScriptRoot -Parent

# Everything in the extension folder except the site, the store kit and hidden files (.git and the like).
$files = Get-ChildItem $root -Force | Where-Object { $_.Name -notin 'site', 'store' -and $_.Name -notlike '.*' } |
    ForEach-Object { if ($_.PSIsContainer) { Get-ChildItem $_.FullName -Recurse -File } else { $_ } }

function Write-Zip($zip, $prefix) {
    New-Item -ItemType Directory -Path (Split-Path $zip) -Force | Out-Null
    if (Test-Path $zip) { Remove-Item $zip }
    # Entries are added one by one so their names use "/", which every unzip tool understands
    # (Windows PowerShell's CreateFromDirectory writes "\").
    $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        foreach ($file in $files) {
            $entry = $prefix + $file.FullName.Substring($root.Length + 1).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, 'Optimal') | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
}

$zip = Join-Path $PSScriptRoot "$name.zip"
Write-Zip $zip "$name/"
Write-Zip (Join-Path $root "store\$name.zip") ''

# Keep the size shown under the download button in step.
$size = [math]::Max(1, [math]::Round((Get-Item $zip).Length / 1KB))
$page = Join-Path $PSScriptRoot 'index.html'
$html = [IO.File]::ReadAllText($page)
[IO.File]::WriteAllText($page, ($html -replace 'zip, \d+ KB', "zip, $size KB"))
Write-Host "Wrote $zip ($size KB) and store\$name.zip"
