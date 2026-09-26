# Builds everything for a GitHub release into .\dist:
#   CargoSetup-<version>.exe              the installer, with Cargo inside (also used for updates)
#   CargoSetup-<version>.exe.sha256       its checksum, which the updater verifies
#   Cargo-<version>-win-x64.zip           the program alone (portable, unzip and run Cargo.exe)
#   Cargo-<version>-win-x64.zip.sha256    its checksum
#   Cargo-<version>-source.zip            the source code without build output
#
# Needs Node.js 20+ (npm install run once) and the .NET 8 SDK for the setup.
# The version comes from package.json.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Zip entries always use forward slashes, whatever the .NET version behind PowerShell does by default.
function New-Zip([string]$Folder, [string]$Destination, [string]$Prefix = '') {
    $archive = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem $Folder -Recurse -File) {
            $name = $Prefix + $file.FullName.Substring($Folder.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally {
        $archive.Dispose()
    }
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE) { throw "$What failed" }
}

# The setup is built twice (without and with the app inside). Build it from scratch each time so the
# small uninstaller never picks up the payload from an earlier build.
function Build-Setup([string]$Out, [string[]]$Properties) {
    foreach ($dir in 'src\setup\bin', 'src\setup\obj') { if (Test-Path $dir) { Remove-Item $dir -Recurse -Force } }
    Invoke-Checked 'Building the setup' { dotnet build 'src\setup\Cargo.Setup.csproj' -c Release --no-incremental @Properties -o $Out --nologo }
}

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
Write-Host "Building Cargo $version"

if (-not (Test-Path 'node_modules')) { Invoke-Checked 'npm install' { npm install } }

# 1. Tests
Invoke-Checked 'The tests' { npm test }

# 2. Icon
if (-not (Test-Path 'build\icon.ico')) { Invoke-Checked 'Rendering the icon' { npm run icons } }

# 3. The program (Electron app folder)
$dist = Join-Path $PSScriptRoot 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
Invoke-Checked 'Packing the app' { npx electron-builder --win dir --x64 }
$app = Join-Path $dist 'app'
Move-Item (Join-Path $dist 'electron\win-unpacked') $app
Remove-Item (Join-Path $dist 'electron') -Recurse -Force
Copy-Item 'LICENSE' (Join-Path $app 'LICENSE.txt')

# 4. The uninstaller: the setup without a payload, which removes Cargo when started with --uninstall
$uninstallOut = Join-Path $dist 'uninstaller'
Build-Setup $uninstallOut @("-p:Version=$version")
if ((Get-Item (Join-Path $uninstallOut 'CargoSetup.exe')).Length -gt 5MB) { throw 'The uninstaller unexpectedly contains a payload' }
Copy-Item (Join-Path $uninstallOut 'CargoSetup.exe') (Join-Path $app 'Uninstall Cargo.exe')
Remove-Item $uninstallOut -Recurse -Force

# 5. The file list. Updates and uninstalling only ever touch the files named here.
$files = Get-ChildItem $app -Recurse -File | ForEach-Object { $_.FullName.Substring($app.Length + 1) } | Sort-Object
[IO.File]::WriteAllLines((Join-Path $app 'cargo-files.txt'), [string[]]($files + 'cargo-files.txt'), (New-Object Text.UTF8Encoding $false))

# 6. Portable zip and checksum
$zipName = "Cargo-$version-win-x64.zip"
$zip = Join-Path $dist $zipName
Write-Host "Zipping $zipName"
New-Zip $app $zip
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256", "$sha  $zipName`n")

# 7. Setup, with the zip inside
$setupOut = Join-Path $dist 'setup'
Build-Setup $setupOut @("-p:Version=$version", "-p:PayloadZip=$zip")
$setupName = "CargoSetup-$version.exe"
Move-Item (Join-Path $setupOut 'CargoSetup.exe') (Join-Path $dist $setupName)
# The in-app updater checks the setup against this before running it.
$setupSha = (Get-FileHash (Join-Path $dist $setupName) -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $dist "$setupName.sha256"), "$setupSha  $setupName`n")
Remove-Item $setupOut, $app -Recurse -Force
# dotnet leaves obj\ in the project; the source zip below skips it anyway.

# 8. Source code, without build output
$source = Join-Path $dist "Cargo-$version-source"
New-Item -ItemType Directory $source | Out-Null
Copy-Item '.gitignore', 'LICENSE', 'README.md', 'package.json', 'package-lock.json', 'build-release.ps1' $source
foreach ($dir in 'src', 'test', 'scripts', 'build', 'docs') {
    if (-not (Test-Path $dir)) { continue }
    robocopy $dir (Join-Path $source $dir) /E /XD bin obj node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed" }
}
$global:LASTEXITCODE = 0
New-Zip $source (Join-Path $dist "Cargo-$version-source.zip") "Cargo-$version-source/"
Remove-Item $source -Recurse -Force

Write-Host ''
Write-Host "Done. Release files are in $dist"
Get-ChildItem $dist | Format-Table Name, @{ Name = 'MB'; Expression = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
