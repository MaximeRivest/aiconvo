param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Distro,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$LinuxUser,
    [ValidateRange(1,65535)][int]$Port = 7433
)
$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'Aiconvo'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.ps1') -Destination (Join-Path $destination 'launch.ps1') -Force
@{ Distro = $Distro; User = $LinuxUser; Port = $Port } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'config.json') -Encoding UTF8
$shell = New-Object -ComObject WScript.Shell
$locations = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($location in $locations) {
    $path = Join-Path $location 'aiconvo.lnk'
    if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath "$path.before-launcher")) {
        Copy-Item -LiteralPath $path -Destination "$path.before-launcher"
    }
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $destination 'launch.ps1') + '"'
    $shortcut.WorkingDirectory = $destination
    $shortcut.Description = 'Start Aiconvo and open its window'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}
Write-Output "Installed Aiconvo launcher for $Distro / $LinuxUser on port $Port."
