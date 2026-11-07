# Windows PowerShell 5.1+ entry point. Default action previews only.
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Install', 'Verify', 'Uninstall')][string]$Action = 'Plan',
    [string]$NodeExecutable = '',
    [string]$DshHome = '',
    [ValidatePattern('^[\w-]+$')][string]$Profile = 'desktop',
    [switch]$Task,
    [switch]$NoTask,
    [switch]$DryRun,
    [switch]$PurgeProfile,
    [switch]$KeepData,
    [switch]$KeepCredentials
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    if ($Task -and $NoTask) { throw 'Use either -Task or -NoTask.' }
    $candidates = @()
    if ($NodeExecutable) { $candidates += $NodeExecutable }
    elseif ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
    else {
        # Prefer the desktop runtime so a global, outdated Node is not required.
        $candidates += (Join-Path $HOME '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCommand) { $candidates += $nodeCommand.Source }
    }
    $node = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$node) { throw 'Node.js 22+ not found. Pass -NodeExecutable with the path to the DSH runtime node.exe.' }
    $node = (Resolve-Path -LiteralPath $node).ProviderPath
    $arguments = @((Join-Path $PSScriptRoot 'install.mjs'), '--profile', $Profile)
    if ($DshHome) { $arguments += @('--dsh-home', $DshHome) }
    if ($Action -eq 'Plan') { $arguments += '--dry-run' }
    elseif ($Action -eq 'Verify') { $arguments += '--verify' }
    elseif ($Action -eq 'Uninstall') { $arguments += '--uninstall' }
    if ($DryRun -and $Action -ne 'Plan') { $arguments += '--dry-run' }
    if ($Task) { $arguments += '--task' }
    if ($NoTask) { $arguments += '--no-task' }
    if ($PurgeProfile) { $arguments += '--purge-profile' }
    if ($KeepData) { $arguments += '--keep-data' }
    if ($KeepCredentials) { $arguments += '--keep-credentials' }
    & $node @arguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
