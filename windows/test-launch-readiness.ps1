# Test readiness without starting WSL, opening a browser, or changing networking.
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'launch.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-AiconvoReady'
}, $true)
if ($null -eq $function) { throw 'Readiness function not found' }
. ([scriptblock]::Create($function.Extent.Text))

# Use a real loopback HTTP fixture: GetResponse throws on HTTP errors.
$job = Start-Job -ScriptBlock {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        Write-Output $listener.LocalEndpoint.Port
        foreach ($status in @(200, 401, 403, 500)) {
            $client = $listener.AcceptTcpClient()
            try {
                $client.ReceiveTimeout = 5000
                $stream = $client.GetStream()
                $reader = [IO.StreamReader]::new($stream)
                while ($null -ne ($line = $reader.ReadLine()) -and $line -ne '') { }
                $bytes = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status Test`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $client.Close() }
        }
    } finally { $listener.Stop() }
}
try {
    $port = $null
    $deadline = (Get-Date).AddSeconds(15)
    while ($null -eq $port -and (Get-Date) -lt $deadline) {
        $port = Receive-Job $job
        if ($null -eq $port) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $port) { throw 'HTTP fixture did not start' }
    foreach ($status in @(200, 401, 403, 500)) {
        $actual = Test-AiconvoReady "http://127.0.0.1:$port/"
        $expected = $status -in @(200, 401)
        if ($actual -ne $expected) { throw "HTTP ${status}: expected $expected, got $actual" }
        Write-Output "PASS HTTP $status -> ready=$actual"
    }
    $done = Wait-Job $job -Timeout 10
    if ($null -eq $done -or $job.State -ne 'Completed') { throw 'HTTP fixture failed' }
    Receive-Job $job | Out-Null
    if (Test-AiconvoReady "http://127.0.0.1:$port/") { throw 'A closed port must not be ready' }
    Write-Output 'PASS connection refused -> ready=False'
} finally {
    Stop-Job $job
    Remove-Job $job -Force
}
