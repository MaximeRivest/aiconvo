# Run with Windows PowerShell 5.1. No admin rights or real port forwards needed.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('aiconvo runner test ' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $runner = Join-Path $root 'lan-forward.exe'
    Add-Type -Path (Join-Path $PSScriptRoot 'lan-forward-runner.cs') -OutputAssembly $runner -OutputType WindowsApplication
    # Verify IMAGE_SUBSYSTEM_WINDOWS_GUI, not WINDOWS_CUI. The distinction is
    # what prevents a console from flashing before any code has even executed.
    $bytes = [IO.File]::ReadAllBytes($runner)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -ne 2) { throw 'Runner is not a windowless executable' }
    $script = Join-Path $root 'lan-forward.ps1'
    @'
param($Distro, $LinuxUser, $Port, $TlsPort)
Write-Output "$Distro|$LinuxUser|$Port|$TlsPort"
# Native children must inherit the absence of a console too.
Add-Type -Name ConsoleProbe -Namespace Test -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();'
if ([Test.ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 99 }
& "$env:SystemRoot\System32\cmd.exe" /c echo native-child-output
[Console]::Error.WriteLine('test-stderr')
exit 23
'@ | Set-Content -LiteralPath $script
    $process = Start-Process -FilePath $runner -ArgumentList 'Ubuntu-24.04 lilly 7433 7443' -PassThru -Wait
    if ($process.ExitCode -ne 23) { throw "Did not preserve child exit code, or child has a console: $($process.ExitCode)" }
    $log = Get-Content -LiteralPath (Join-Path $root 'lan-forward.log') -Raw
    foreach ($expected in @('Ubuntu-24.04|lilly|7433|7443', 'native-child-output', 'test-stderr')) {
        if (-not $log.Contains($expected)) { throw "Missing output: $expected" }
    }
    foreach ($arguments in @('Ubuntu lilly 0 7443', 'Ubuntu lilly 7433 65536', 'Ubuntu lilly 7433', 'Ubuntu;bad lilly 7433 7443')) {
        $process = Start-Process -FilePath $runner -ArgumentList $arguments -PassThru -Wait
        if ($process.ExitCode -ne 1) { throw "Accepted invalid arguments: $arguments" }
    }
    Remove-Item -LiteralPath $script
    $process = Start-Process -FilePath $runner -ArgumentList 'Ubuntu lilly 7433 7443' -PassThru -Wait
    if ($process.ExitCode -eq 0) { throw 'Missing script was reported as success' }
    Write-Output 'PASS: no console, path with spaces, argument forwarding, native child, stdout/stderr, exit codes, invalid arguments, missing script'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
