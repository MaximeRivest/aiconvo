# Windows launcher

WSL systemd services do not start when a browser shortcut opens. They also do not keep WSL alive.

`setup.sh` installs this launcher on WSL. For an existing installation, run:

```sh
bash windows/install-from-wsl.sh
```

Set `PORT` if the server uses a different port. Run this from the distribution and Linux user that own the service. Requires WSL with systemd, bash, flock, Windows PowerShell, and Windows interop. Distribution names must contain only letters, digits, dots, underscores, and hyphens.

The installer copies the launcher and configuration into Windows LocalAppData/Aiconvo. It creates Desktop and Start Menu shortcuts and saves existing shortcuts with a `.before-launcher` suffix. No administrator rights, scheduled tasks, or global execution-policy changes are needed. Running the installer again updates its files.

The launcher starts the existing service without restarting it. A locked keeper process holds WSL open. Repeated launches do not create additional keepers. It waits up to 90 seconds for HTTP readiness, bypassing proxy settings. It opens Chrome or Edge in app mode, or the default browser as fallback. Existing browser-installed or taskbar shortcuts do not gain this behavior; replace them with the new shortcut.

Trade-offs: WSL remains running after the browser closes. Browser app mode can use a different profile from a previous browser-installed app. Users might need to select their usual browser profile. Startup does not install or update application dependencies. A successful HTTP check confirms server availability, not complete browser rendering.

For a non-visual readiness check, run the installed `launch.ps1 -CheckOnly` from Windows PowerShell. Startup errors are also written to `startup-error.log`. Test cold startup only when no other WSL work is active: close WSL, then launch from the Desktop. Never shut down a user's WSL session merely to test this.

To remove the launcher, remove its Desktop and Start Menu shortcuts and LocalAppData/Aiconvo. Restore saved shortcuts if wanted. This does not remove the Linux service or user data.
