# Decrypt the DPAPI-protected credentials and print them as JSON on stdout.
# Called by the plugin only when a silent login is required.
Add-Type -AssemblyName System.Security
$ErrorActionPreference = 'Stop'
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$file = Join-Path $dshRoot 'easycompute-credentials.bin'
if (-not (Test-Path $file)) { Write-Output 'MISSING'; exit 2 }
try {
  $protected = [System.IO.File]::ReadAllBytes($file)
  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.Text.Encoding]::UTF8.GetString($bytes)
} catch {
  Write-Output 'DECRYPT_FAILED'
  exit 3
}
