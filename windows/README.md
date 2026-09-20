# Windows launcher

WSL systemd services do not start when a browser shortcut opens. They also do not keep WSL alive.

`setup.sh` installs this launcher on WSL. For an existing installation, run:

```sh
bash windows/install-from-wsl.sh
```

Set `PORT` if the server uses a different port. Run this from the distribution and Linux user that own the service. Requires WSL with systemd, bash, flock, Windows PowerShell, and Windows interop. Distribution names must contain only letters, digits, dots, underscores, and hyphens.

The installer copies the launcher and configuration into Windows LocalAppData/Aiconvo. It creates Desktop and Start Menu shortcuts and saves existing shortcuts with a `.before-launcher` suffix. No administrator rights, scheduled tasks, or global execution-policy changes are needed. Running the installer again updates its files.

The launcher starts the existing service without restarting it. A locked keeper process holds WSL open. Repeated launches do not create additional keepers. It waits up to 90 seconds for the server to answer at `/health`, bypassing proxy settings. That route answers before sign-in, so the check works whether or not the machine is reachable from the network; an older server (without the route) answers 401 there, which the launcher also takes as "up". A login page in the window is expected the first time: from Windows, even the local browser reaches the server through the port forward, so the server treats it as another device and asks for the token once. The launcher never bypasses that. It opens Chrome or Edge in app mode, or the default browser as fallback. Existing browser-installed or taskbar shortcuts do not gain this behavior; replace them with the new shortcut.

Trade-offs: WSL remains running after the browser closes. Browser app mode can use a different profile from a previous browser-installed app. Users might need to select their usual browser profile. Startup does not install or update application dependencies. A successful HTTP check confirms server availability, not complete browser rendering.

`./update.sh` inside WSL refreshes the Windows copies of `launch.ps1` and `lan-forward.ps1` when they exist, so fixes to either reach an installed machine with the ordinary update. Re-running the installers is only needed to change the distribution, user or port.

Test the readiness logic without WSL or a browser: `powershell -NoProfile -ExecutionPolicy Bypass -File test-launch-readiness.ps1` (checks 200 and 401 count as ready, 403, 500 and a refused connection do not).

For a non-visual readiness check, run the installed `launch.ps1 -CheckOnly` from Windows PowerShell. Startup errors are also written to `startup-error.log`. Test cold startup only when no other WSL work is active: close WSL, then launch from the Desktop. Never shut down a user's WSL session merely to test this.

## Reaching it from other devices

The switch in aiconvo settings → machines makes the server listen for the network, but on WSL that network is a private one inside the WSL virtual machine (Windows 10, or Windows 11 without mirrored networking). Windows must forward the ports in, and the WSL address changes after every restart. Once, from an **administrator** PowerShell in this folder (as seen from Windows, e.g. `\\wsl$\Ubuntu-24.04\home\lilly\aiconvo\windows`):

```powershell
powershell -ExecutionPolicy Bypass -File install-lan-forward.ps1 -Distro Ubuntu-24.04 -LinuxUser lilly
```

This adds a firewall rule for ports 7433 and 7443 (private networks only), forwards them to WSL now, and schedules `lan-forward.ps1` at logon and every 10 minutes so the forward follows WSL's address. The script only rewrites a forward whose target has actually changed: re-adding one drops every connection through it (open pages, the collaboration WebSocket, agent event streams), and doing that on a 10-minute clock made the server's connections reset on schedule. The links under settings → machines then carry the Windows address first (the server asks Windows for it), so they can be copied as they are. To undo: `Unregister-ScheduledTask 'Aiconvo LAN forward'`, `netsh interface portproxy reset`, and remove the `Aiconvo` firewall rule.

### Fixing a recurring console flash

Older installs start the forwarding task with `powershell.exe -WindowStyle Hidden`. Windows can create its console before PowerShell hides it, producing a brief flash every 10 minutes. Re-run the administrator command above from an updated checkout to replace the existing task (not add a second one).

The installer now builds `lan-forward.exe` using Windows PowerShell's built-in .NET compiler. It is a Windows application, not a console application, and starts its PowerShell child with console creation disabled. The task keeps the same user, administrator rights, logon trigger, and 10-minute schedule; running as SYSTEM would lose access to the user's WSL distribution. No VBScript dependency, passwords, or execution-policy changes are added. Trade-off: one small executable is installed alongside the script; environments that block locally compiled executables may require administrator approval.

The latest run's output/errors are in `%LOCALAPPDATA%\Aiconvo\lan-forward.log`, and the child exit code is passed back to Task Scheduler. To test the runner without changing any networking, run `powershell -NoProfile -ExecutionPolicy Bypass -File test-lan-forward-runner.ps1` on Windows. A recurring flash is not proof this task caused it; check whether it stops after the update.

To remove the launcher, remove its Desktop and Start Menu shortcuts and LocalAppData/Aiconvo. Restore saved shortcuts if wanted. This does not remove the Linux service or user data.
