param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    # A live WSL process keeps the distribution available. systemd alone does not.
    # flock permits only one keeper for this Linux user, including repeated launches.
    $command = 'systemctl --user start aiconvo.service && exec flock -n "$XDG_RUNTIME_DIR/aiconvo-launcher.lock" sleep infinity'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
    $arguments = @('-d', $config.Distro, '-u', $config.User, '--exec', 'bash', '-c', ('"echo ' + $encoded + ' | base64 -d | bash"'))
    $worker = Start-Process -FilePath "$env:SystemRoot\System32\wsl.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $PSScriptRoot 'startup-error.log')
    $url = "http://localhost:$($config.Port)/"
    $ready = $false
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        try {
            $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($config.Port)/")
            $request.Proxy = $null
            $request.Timeout = 2000
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            $response.Close()
            if ($status -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Aiconvo did not start within 90 seconds. Open your WSL terminal and run: systemctl --user status aiconvo" }
    if ($CheckOnly) { Write-Output "Aiconvo is ready at $url"; return }
    $browsers = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    $browser = $browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($browser) { Start-Process -FilePath $browser -ArgumentList "--app=$url" }
    else { Start-Process $url }
} catch {
    if ($CheckOnly) { Write-Error $_; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Aiconvo could not open', 'OK', 'Error') | Out-Null
    exit 1
}
