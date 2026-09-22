# Register the WSL port forward so Chattering is reachable from other devices
# after every restart. Run once from an administrator PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install-lan-forward.ps1 -Distro Ubuntu-24.04 -LinuxUser lilly
#
# It copies lan-forward.ps1 next to the launcher, runs it now, and schedules
# it at logon and every 10 minutes (WSL's address changes after a restart).
# Pair it with the switch in Chattering settings -> machines, which makes the
# server inside WSL listen for the network in the first place.
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Distro,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$LinuxUser,
    [ValidateRange(1,65535)][int]$Port = 7433,
    [ValidateRange(1,65535)][int]$TlsPort = 7443
)
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this from an administrator PowerShell (port forwards and firewall rules need it).' }
$destination = Join-Path $env:LOCALAPPDATA 'Chattering'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
# -WindowStyle Hidden hides a console only AFTER PowerShell starts. Instead,
# build a GUI-subsystem runner that starts PowerShell with CREATE_NO_WINDOW.
# Use Windows' built-in .NET compiler, not VBScript (optional on newer Windows).
$runner = Join-Path $destination 'lan-forward.exe'
$build = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $build | Out-Null
try {
    $compiled = Join-Path $build 'lan-forward.exe'
    Add-Type -Path (Join-Path $PSScriptRoot 'lan-forward-runner.cs') -OutputAssembly $compiled -OutputType WindowsApplication
    Copy-Item -LiteralPath $compiled -Destination $runner -Force
} finally {
    Remove-Item -LiteralPath $build -Recurse -Force
}
$script = Join-Path $destination 'lan-forward.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lan-forward.ps1') -Destination $script -Force
$arguments = "$Distro $LinuxUser $Port $TlsPort"
$action = New-ScheduledTaskAction -Execute $runner -Argument $arguments
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$atLogon.Delay = 'PT1M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Chattering LAN forward' -Action $action -Trigger @($atLogon, $repeat) -Settings $settings -RunLevel Highest -User $env:USERNAME -Force | Out-Null
$check = Start-Process -FilePath $runner -ArgumentList $arguments -Wait -PassThru
if ($check.ExitCode -ne 0) { throw "Port forwarding failed. See $destination\lan-forward.log (exit $($check.ExitCode))." }
Get-Content -LiteralPath (Join-Path $destination 'lan-forward.log')
Write-Output "Scheduled 'Chattering LAN forward' without a console window (at logon and every 10 minutes)."
