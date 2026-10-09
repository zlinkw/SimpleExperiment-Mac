param(
    [string]$BundleRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$bundle = Resolve-Path -LiteralPath $BundleRoot
$sftp = Get-ChildItem -LiteralPath $bundle -Filter "simple-sftp-*.vsix" | Sort-Object Name -Descending | Select-Object -First 1
$experiment = Get-ChildItem -LiteralPath $bundle -Filter "simple-experiment-*.vsix" | Sort-Object Name -Descending | Select-Object -First 1

if (-not $sftp -or -not $experiment) {
    throw "Bundle must contain simple-sftp-*.vsix and simple-experiment-*.vsix."
}

$code = Get-Command code -ErrorAction SilentlyContinue
if (-not $code) {
    throw "VS Code code command not found. Install the shell command and retry."
}

$publicExtensionIds = @(
    "simple-local.simple-sftp",
    "simple-local.simple-experiment"
)
$legacyExtensionIds = @(
    "simple-local.simple-sftp-manager",
    "simple-local.simple-experiment"
)

function Get-InstalledExtensionIds {
    $installed = @(& $code.Source --list-extensions)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list installed VS Code extensions."
    }
    return @($installed | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ })
}

function Test-ExtensionInstalled([string[]]$Installed, [string]$ExtensionId) {
    return $Installed -contains $ExtensionId.ToLowerInvariant()
}

foreach ($extension in @($sftp, $experiment)) {
    & $code.Source --install-extension $extension.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Installation failed: $($extension.Name)"
    }
}

$installed = Get-InstalledExtensionIds
foreach ($extensionId in $publicExtensionIds) {
    if (-not (Test-ExtensionInstalled $installed $extensionId)) {
        throw "Installed extension verification failed: $extensionId"
    }
}

$removedLegacy = @()
foreach ($extensionId in $legacyExtensionIds) {
    if (-not (Test-ExtensionInstalled $installed $extensionId)) {
        continue
    }
    & $code.Source --uninstall-extension $extensionId
    if ($LASTEXITCODE -ne 0) {
        throw "Legacy extension removal failed: $extensionId"
    }
    $removedLegacy += $extensionId
}

$installed = Get-InstalledExtensionIds
foreach ($extensionId in $publicExtensionIds) {
    if (-not (Test-ExtensionInstalled $installed $extensionId)) {
        throw "Installed extension verification failed: $extensionId"
    }
}
foreach ($extensionId in $legacyExtensionIds) {
    if (Test-ExtensionInstalled $installed $extensionId) {
        throw "Legacy extension is still installed: $extensionId"
    }
}

Write-Host "Installed SimpleSFTP and SimpleExperiment."
if ($removedLegacy.Count -gt 0) {
    Write-Host "Removed legacy extensions: $($removedLegacy -join ', ')."
}
Write-Warning "Required: run 'Developer: Reload Window' in every open VS Code window before using the extensions."
Write-Host "Until reload completes, status-bar items from the unloaded legacy extensions can remain beside the new SimpleSFTP/SimpleExperiment UI."
