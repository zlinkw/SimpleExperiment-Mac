$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

npm run package
if ($LASTEXITCODE -ne 0) { throw "Packaging failed." }
npm run install:latest
if ($LASTEXITCODE -ne 0) { throw "Installation failed." }
