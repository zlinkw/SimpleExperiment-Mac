param(
    [string]$ReleaseDirectory = (Join-Path $PSScriptRoot "..\\release"),
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sftpRoot = (Resolve-Path (Join-Path $root "..\\simple-sftp")).Path

function Invoke-NpmScript([string]$WorkingDirectory, [string]$Script) {
    Push-Location $WorkingDirectory
    try {
        & npm run $Script
        if ($LASTEXITCODE -ne 0) {
            throw "npm run $Script failed: $WorkingDirectory"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-VscePackage([string]$WorkingDirectory, [string]$OutputPath) {
    Push-Location $WorkingDirectory
    try {
        & npm exec -- @vscode/vsce package --no-dependencies --out $OutputPath --allow-missing-repository
        if ($LASTEXITCODE -ne 0) {
            throw "vsce package failed: $WorkingDirectory"
        }
    }
    finally {
        Pop-Location
    }
}

$sftpPackage = Get-Content -Raw -Encoding UTF8 (Join-Path $sftpRoot "package.json") | ConvertFrom-Json
$experimentPackage = Get-Content -Raw -Encoding UTF8 (Join-Path $root "package.json") | ConvertFrom-Json
$bundle = Join-Path $ReleaseDirectory "SimpleExperiment-$($experimentPackage.version)"
if (Test-Path -LiteralPath $bundle) {
    throw "Release bundle already exists and will not be overwritten: $bundle"
}
if (-not $SkipTests) {
    Invoke-NpmScript $sftpRoot "test"
    Invoke-NpmScript $root "test"
}
else {
    Invoke-NpmScript $root "build"
}

$releaseParent = Split-Path -Parent $bundle
New-Item -ItemType Directory -Force -Path $releaseParent | Out-Null
New-Item -ItemType Directory -Path $bundle | Out-Null

$sftpVsix = Join-Path $bundle "$($sftpPackage.name)-$($sftpPackage.version).vsix"
$experimentVsix = Join-Path $bundle "$($experimentPackage.name)-$($experimentPackage.version).vsix"

Invoke-VscePackage $sftpRoot $sftpVsix
Invoke-VscePackage $root $experimentVsix

foreach ($file in @($sftpVsix, $experimentVsix)) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Missing package output: $file"
    }
}

foreach ($source in @(
        (Join-Path $root "scripts\\install-public-release.ps1"),
        (Join-Path $root "docs\\simple-experiment-setup.md")
    )) {
    $destination = Join-Path $bundle (Split-Path -Leaf $source)
    [System.IO.File]::Copy($source, $destination, $false)
}

$readme = @(
    "# SimpleExperiment Offline Bundle",
    "",
    "1. Run install-public-release.ps1 from this directory.",
    "2. In every open VS Code window, run Developer: Reload Window.",
    "3. Run SimpleExperiment: Open Setup Guide from VS Code Command Palette.",
    "4. Configure Xshell sessions, then set Hub/Worker project parent directories in SimpleExperiment.",
    "",
    "This bundle installs SimpleSFTP and SimpleExperiment together.",
    "The installer removes legacy simple-local extension IDs after the public extensions are verified.",
    "Before reload, an already-running legacy extension host can temporarily leave old private status-bar items beside the new UI."
) -join [Environment]::NewLine

$readmePath = Join-Path $bundle "README.md"
[System.IO.File]::WriteAllText($readmePath, $readme, [System.Text.UTF8Encoding]::new($false))

Write-Host "Offline bundle created: $bundle"
