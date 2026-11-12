# Packs the extension three times and updates the size shown on the download page. Run it again
# after changing the extension.
#   site\playlist-multi-save.zip           the page's download: files in a folder named
#                                          playlist-multi-save, ready for "Load unpacked" after unzipping
#   store\playlist-multi-save.zip          for the Chrome Web Store, which wants manifest.json at the top
#   store\playlist-multi-save-firefox.zip  for Firefox (addons.mozilla.org): the same, with Firefox's
#                                          settings added to manifest.json (see $gecko below)
#
#   powershell -ExecutionPolicy Bypass -File site\make-zip.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$name = 'playlist-multi-save'
$root = Split-Path $PSScriptRoot -Parent

# Everything in the extension folder except the site, the store kit and hidden files (.git and the like).
$files = Get-ChildItem $root -Force | Where-Object { $_.Name -notin 'site', 'store' -and $_.Name -notlike '.*' } |
    ForEach-Object { if ($_.PSIsContainer) { Get-ChildItem $_.FullName -Recurse -File } else { $_ } }

# Firefox needs an ID of its own (it can't change once the add-on is published) and a statement of
# what data the add-on collects (none). Version 140 is the first that knows that statement, and it
# runs scripts in the page's own world (content.js) too. Chrome-only keys are left out.
$gecko = @"
  "browser_specific_settings": {
    "gecko": {
      "id": "$name@nikma.xyz",
      "strict_min_version": "140.0",
      "data_collection_permissions": { "required": ["none"] }
    }
  },
"@
$manifest = [IO.File]::ReadAllText((Join-Path $root 'manifest.json'))
$firefoxManifest = ($manifest -replace '("manifest_version": 3,\r?\n)', "`$1$gecko`n") -replace '\r?\n\s*"minimum_chrome_version": "[^"]*",', ''

function Write-Zip($zip, $prefix, $manifestText = $null) {
    New-Item -ItemType Directory -Path (Split-Path $zip) -Force | Out-Null
    if (Test-Path $zip) { Remove-Item $zip }
    # Entries are added one by one so their names use "/", which every unzip tool understands
    # (Windows PowerShell's CreateFromDirectory writes "\").
    $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        foreach ($file in $files) {
            $entry = $prefix + $file.FullName.Substring($root.Length + 1).Replace('\', '/')
            if ($manifestText -and $entry -eq "${prefix}manifest.json") {
                $writer = New-Object IO.StreamWriter($archive.CreateEntry($entry, 'Optimal').Open(), (New-Object Text.UTF8Encoding($false)))
                $writer.Write($manifestText)
                $writer.Dispose()
            } else {
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, 'Optimal') | Out-Null
            }
        }
    } finally {
        $archive.Dispose()
    }
}

$zip = Join-Path $PSScriptRoot "$name.zip"
Write-Zip $zip "$name/"
Write-Zip (Join-Path $root "store\$name.zip") ''
Write-Zip (Join-Path $root "store\$name-firefox.zip") '' $firefoxManifest

# Keep the size shown under the download button in step.
$size = [math]::Max(1, [math]::Round((Get-Item $zip).Length / 1KB))
$page = Join-Path $PSScriptRoot 'index.html'
$html = [IO.File]::ReadAllText($page)
[IO.File]::WriteAllText($page, ($html -replace 'zip, \d+ KB', "zip, $size KB"))
Write-Host "Wrote $zip ($size KB), store\$name.zip and store\$name-firefox.zip"
