# Register the WSL port forward so aiconvo is reachable from other devices
# after every restart. Run once from an administrator PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install-lan-forward.ps1 -Distro Ubuntu-24.04 -LinuxUser lilly
#
# It copies lan-forward.ps1 next to the launcher, runs it now, and schedules
# it at logon and every 10 minutes (WSL's address changes after a restart).
# Pair it with the switch in aiconvo settings -> machines, which makes the
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
$destination = Join-Path $env:LOCALAPPDATA 'Aiconvo'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$script = Join-Path $destination 'lan-forward.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lan-forward.ps1') -Destination $script -Force
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Distro $Distro -LinuxUser $LinuxUser -Port $Port -TlsPort $TlsPort"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$atLogon.Delay = 'PT1M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Aiconvo LAN forward' -Action $action -Trigger @($atLogon, $repeat) -Settings $settings -RunLevel Highest -User $env:USERNAME -Force | Out-Null
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Distro $Distro -LinuxUser $LinuxUser -Port $Port -TlsPort $TlsPort
Write-Output "Scheduled 'Aiconvo LAN forward' (at logon and every 10 minutes)."
