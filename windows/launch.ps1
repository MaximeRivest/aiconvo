param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

# "Ready" means the server answered. It is probed at /health, which the
# server answers before sign-in. An older server without that route answers
# 401 there (the sign-in gate comes first), which still proves it is up:
# under WSL even a local browser reaches the server through the Windows
# port forward, so the server sees it as another machine and asks for the
# token. Refused or timed-out connections are the only "not yet".
function Test-AiconvoReady([string]$Url) {
    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        return ([int]$response.StatusCode -eq 200)
    } catch [Net.WebException] {
        $response = $_.Exception.Response
        return ($null -ne $response -and [int]$response.StatusCode -eq 401)
    } finally {
        if ($null -ne $response) { $response.Close() }
    }
}

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
        if (Test-AiconvoReady "http://127.0.0.1:$($config.Port)/health") {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Aiconvo did not start within 90 seconds. Open your WSL terminal and run: systemctl --user status aiconvo" }
    if ($CheckOnly) { Write-Output "Aiconvo is ready at $url"; return }
    # From Windows the browser reaches the server through the port forward,
    # so the server sees another device and asks for the install token. The
    # token lives in this Linux user's own files, which this launcher already
    # runs as; carry it along once and the browser stays signed in. This is
    # the same sign-in the connect links use, not a way around it. Without
    # the file (server local-only) the plain address signs in by itself.
    $tokenRaw = & "$env:SystemRoot\System32\wsl.exe" -d $config.Distro -u $config.User --exec cat "/home/$($config.User)/.cache/aiconvo/lan-token" 2>$null
    $token = (($tokenRaw -join '') -replace "`0", '').Trim()
    if ($token -match '^[A-Za-z0-9_-]{8,}$') { $url = "$url`?token=$token" }
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
