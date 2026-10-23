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
        (Join-Path $root "scripts\\install-public-release.ps1")
    )) {
    $destination = Join-Path $bundle (Split-Path -Leaf $source)
    [System.IO.File]::Copy($source, $destination, $false)
}

# 0.5.400 用户裁决：离线 bundle 不再附带 setup 指南、不再生成 bundle README（均非 vsce 强制项）；终端提示在线指南 URL。
$onlineGuideUrl = "https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md"

Write-Host "Offline bundle created: $bundle"
Write-Host "Setup guide (online): $onlineGuideUrl"
