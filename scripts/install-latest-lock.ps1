param([Parameter(Mandatory=$true)][string]$LockPath)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$lockItem = [System.IO.Path]::GetFullPath($LockPath)
$directParent = Split-Path -Parent $lockItem
if (!(Test-Path -LiteralPath $directParent -PathType Container)) { throw 'Install lock parent is missing' }
if ((Get-Item -LiteralPath $directParent).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Unsafe install lock parent' }
if (Test-Path -LiteralPath $lockItem) {
  $item = Get-Item -LiteralPath $lockItem
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe install lock target' }
}
# Fixed slot, held by the OS. Parent exit closes stdin and releases the descriptor.
$held = [System.IO.File]::Open($lockItem, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  [Console]::WriteLine('LOCKED')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally { $held.Dispose() }
