# Creates the Windows scheduled task that keeps the Tsinghua session alive
# while DSH is closed. Run once per machine:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows-task.ps1
#
# Uses the ScheduledTasks cmdlets (Unicode-safe), so the plugin may live under a
# path containing non-ASCII characters.
param(
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'DSH Tsinghua Balance Refresh',
  [int]$IntervalMinutes = 360
)

$ErrorActionPreference = 'Stop'

$entry = Join-Path $PluginDir 'lib\scheduled.mjs'
if (-not (Test-Path $entry)) {
  throw "scheduled.mjs not found under $PluginDir (pass -PluginDir explicitly if the repo lives elsewhere)"
}

$candidates = @()
foreach ($c in @(
  $env:DSH_NODE,
  'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
)) {
  if ($c -and (Test-Path $c)) { $candidates += $c }
}
if ($candidates.Count -eq 0) {
  $onPath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if ($onPath) { $candidates += $onPath }
}
if ($candidates.Count -eq 0) { throw 'node.exe not found; set DSH_NODE or install Node 22+' }

$node = $candidates[0]
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entry + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "node  : $node"
Write-Output "entry : $entry"
Write-Output "task  : $TaskName (every $IntervalMinutes min)"
Write-Output ''
Write-Output 'Verify now:'
Write-Output "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Output "  $node `"$entry`""
