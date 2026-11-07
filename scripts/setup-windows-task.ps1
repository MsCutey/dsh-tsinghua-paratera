# Opt-in, current-user scheduled task. -Remove never needs Node or the plugin.
[CmdletBinding()]
param(
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [Alias('NodePath')][string]$NodeExecutable = $env:DSH_NODE,
  [string]$TaskName,
  [ValidateRange(5, 525600)][int]$IntervalMinutes = 360,
  [switch]$Remove,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Resolve-AbsolutePath([string]$Value) {
  # GetFullPath alone accepts drive-relative paths, which depend on login cwd.
  if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') {
    throw 'An absolute Windows path is required.'
  }
  return [System.IO.Path]::GetFullPath($Value)
}
function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Find-Task {
  # Enumerating the root distinguishes absence from access/cmdlet failures, and
  # exact comparison avoids wildcard task names matching somebody else's task.
  return @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName })
}

$DshHome = Resolve-AbsolutePath $DshHome
$defaultHome = Resolve-AbsolutePath (Join-Path $env:USERPROFILE '.dsh')
$canonicalHome = $DshHome.TrimEnd('\', '/').ToLowerInvariant()
if (-not $TaskName) {
  $TaskName = 'DSH Tsinghua Balance Refresh'
  if ($canonicalHome -ne $defaultHome.TrimEnd('\', '/').ToLowerInvariant()) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonicalHome))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $TaskName += ' ' + $hash.Substring(0, 12)
  }
}
if ($TaskName -match '[\\/\x00-\x1f*?]' -or $TaskName.Length -gt 200) { throw 'Invalid task name.' }

if ($Remove) {
  if ($DryRun) {
    @{ ok = $true; dryRun = $true; remove = $true; taskName = $TaskName; dshHome = $DshHome } | ConvertTo-Json -Compress
    return
  }
  $existing = @(Find-Task)
  foreach ($task in $existing) {
    # Stop before unregistering: deleting a task alone does not stop its process.
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
    Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
  }
  if (@(Find-Task).Count -ne 0) { throw 'Task removal could not be verified.' }
  @{ ok = $true; removed = ($existing.Count -gt 0); taskName = $TaskName; dshHome = $DshHome } | ConvertTo-Json -Compress
  return
}

$PluginDir = Resolve-AbsolutePath $PluginDir
$entry = Join-Path $PluginDir 'lib\scheduled.mjs'
if (-not [System.IO.File]::Exists($entry)) { throw 'scheduled.mjs not found; pass -PluginDir explicitly.' }
if (-not $NodeExecutable) {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' }
  $onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $NodeExecutable = $candidates | Where-Object { [System.IO.File]::Exists($_) } | Select-Object -First 1
}
if (-not $NodeExecutable) { throw 'node.exe not found; pass -NodeExecutable or set DSH_NODE.' }
$NodeExecutable = Resolve-AbsolutePath $NodeExecutable
if (-not [System.IO.File]::Exists($NodeExecutable)) { throw 'Node executable does not exist.' }

# Windows tasks cannot store an environment block. An encoded, literal-only
# command preserves DSH_HOME, Unicode, apostrophes and shell metacharacters,
# without relying on global environment variables or a generated wrapper file.
$command = '$ErrorActionPreference = ''Stop''; $env:DSH_HOME = ' + (Quote-Literal $DshHome) + '; $env:DSH_NODE = ' + (Quote-Literal $NodeExecutable) + '; & ' + (Quote-Literal $NodeExecutable) + ' ' + (Quote-Literal $entry) + '; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
if ($DryRun) {
  @{ ok = $true; dryRun = $true; remove = $false; taskName = $TaskName; dshHome = $DshHome; node = $NodeExecutable; execute = $shell; arguments = $arguments; workingDirectory = $PluginDir; intervalMinutes = $IntervalMinutes } | ConvertTo-Json -Compress
  return
}

$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $PluginDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
@{ ok = $true; taskName = $TaskName; dshHome = $DshHome; intervalMinutes = $IntervalMinutes } | ConvertTo-Json -Compress
