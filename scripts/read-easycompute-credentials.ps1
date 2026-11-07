# Decrypt only for silent login. -Status checks metadata without loading DPAPI.
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$file = Join-Path ([System.IO.Path]::GetFullPath($DshHome)) 'easycompute-credentials.bin'
$item = $null
try { $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { }
if ($null -eq $item) { Write-Output 'MISSING'; exit 2 }
if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Write-Output 'INVALID_FILE'; exit 3 }
if ($Status) { Write-Output 'SAVED'; exit 0 }
Add-Type -AssemblyName System.Security
$bytes = $null
try {
  $protected = [System.IO.File]::ReadAllBytes($file)
  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.Text.Encoding]::UTF8.GetString($bytes)
} catch {
  Write-Output 'DECRYPT_FAILED'
  exit 3
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
}
