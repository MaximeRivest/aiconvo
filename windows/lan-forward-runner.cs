// Built as a Windows application: no console is allocated, even at startup.
// Keep the task in its owner's session because WSL distributions are per-user.
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class LanForwardRunner
{
    private static int Main(string[] args)
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string log = Path.Combine(directory, "lan-forward.log");
        try
        {
            int port, tlsPort;
            if (args.Length != 4 ||
                !Regex.IsMatch(args[0], @"\A[a-zA-Z0-9_.-]+\z") ||
                !Regex.IsMatch(args[1], @"\A[a-zA-Z0-9_.-]+\z") ||
                !Int32.TryParse(args[2], out port) || port < 1 || port > 65535 ||
                !Int32.TryParse(args[3], out tlsPort) || tlsPort < 1 || tlsPort > 65535)
                throw new ArgumentException("Expected: distro linux-user port tls-port");

            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                    @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                    Path.Combine(directory, "lan-forward.ps1") + "\" -Distro " + args[0] +
                    " -LinuxUser " + args[1] + " -Port " + port + " -TlsPort " + tlsPort,
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                // Drain both pipes concurrently; an error must not block the task.
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                Task.WaitAll(output, error);
                File.WriteAllText(log, DateTimeOffset.Now.ToString("o") + Environment.NewLine +
                    output.Result + error.Result);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            // No error dialog from an unattended job. Task Scheduler also sees failure.
            try { File.WriteAllText(log, DateTimeOffset.Now.ToString("o") + Environment.NewLine + error); }
            catch { }
            return 1;
        }
    }
}
