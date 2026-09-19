# Let other devices reach the aiconvo that runs inside WSL.
#
# WSL2 lives behind its own private address, which changes after a Windows
# restart, so a one-time port forward goes stale. This script re-points the
# forward at the current WSL address; install-lan-forward.ps1 registers it to
# run at logon and every few minutes. Requires administrator rights.
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Distro,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$LinuxUser,
    [ValidateRange(1,65535)][int]$Port = 7433,
    [ValidateRange(1,65535)][int]$TlsPort = 7443
)
$ErrorActionPreference = 'Stop'
$raw = & "$env:SystemRoot\System32\wsl.exe" -d $Distro -u $LinuxUser -- hostname -I
$ip = (($raw -join ' ') -replace "`0", '').Trim().Split(' ')[0]
if ($ip -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "could not read the WSL address of $Distro (got '$ip')" }
foreach ($p in @($Port, $TlsPort)) {
    & netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>&1 | Out-Null
    & netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$ip | Out-Null
}
if (-not (Get-NetFirewallRule -DisplayName 'Aiconvo' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Aiconvo' -Direction Inbound -Protocol TCP -LocalPort @($Port, $TlsPort) -Action Allow -Profile Private,Domain | Out-Null
}
Write-Output "aiconvo: ports $Port and $TlsPort forward to WSL at $ip"
