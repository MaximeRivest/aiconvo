# Native Windows distribution: first investigation

Status: proposal, not implemented or Windows-tested.
Source inspected: `6db5d63` on lambda (Linux).
Scope: Chattering running on the Windows computer itself, without WSL or a remote Chattering server. Model providers can still be online services.
Part of TODO item 2 (safe for strangers); its five rules (consent first, set up in the app, migrate personal defaults, real walls, a stranger's success as the finish line) apply here.

## Product goal

One download, open Chattering, find existing Claude Code/Pi conversations or start the first one. No Git clone, npm commands, Linux distribution, or developer setup required from an ordinary user.

Two independent capabilities:

1. **Read your records.** Browse, search and export existing local conversations without an agent installation, model login, or model calls.
2. **Work with an agent.** Choose a folder, connect a supported model provider, and run Pi locally from Chattering.

Having Claude Code transcripts is not proof of having usable model credentials. Having Claude Code credentials is not proof that a particular Pi provider can use them. Never promise that a subscription works until the supported provider integration is verified.

## What exists now

- `README.md`, `setup.sh`, and `windows/launch.ps1` document and implement Windows **through WSL**, not native execution.
- The UI is browser-based. Much of the backend uses standard Node filesystem/HTTP APIs and SQLite. A UI rewrite is not indicated by this investigation.
- `server.js` discovers `.claude/projects`, `.pi/agent/sessions`, and `.pi/remote/sessions` under `os.homedir()`. These are promising native Windows defaults, not proof that all Windows installations use them. Custom agent directories need explicit support.
- Missing conversation folders are tolerated during scanning. But `watch()` skips missing source roots, and the drift sweep checks already indexed files. A blank machine needs discovery of a source root created later, not just an initial empty scan.
- Pi's installed Windows documentation supports a native Windows process, Git Bash by default, and an optional PowerShell tool. Chattering still has to launch and host it correctly.
- `pisdk-runtime.js` records a tested Pi version of `0.84.1`; this is a compatibility marker, not a reproducible distribution manifest.
- There is no root dependency manifest/lockfile or native Windows release pipeline in this checkout.

Earlier investigation: conversation `b4e35c6f`, 2026-09-06, reported distribution blockers around runtime packaging, defaults and lifecycle. That is historical evidence, not proof of today's state. The observations below were checked in current source. Related planning: `TODO.md` section 2 and `design/32-ship-readiness-and-feature-flags.md` section 2.

## First-run journeys

### Existing Claude Code and/or Pi history

1. Show detected locations and counts; let the person choose which to index and add other folders.
2. Read the original JSONL files in place; do not move them, rewrite headers, install extensions into their global Pi, or replace their tools.
3. Explain that local word search needs no model and uploads nothing. Automatic titles, notes, semantic uploads and other model work stay off until separately enabled.
4. Keep records readable when their original project folder no longer exists. Ask for a local folder only when the person wants to work from that history.
5. Offer compatible existing Pi settings/auth as an explicit integration. Do not blindly execute every discovered extension: extensions are executable code, not just preferences.
6. Until external-session ownership is reliable on Windows, read external history but make a separate local Pi fork for continuation rather than writing into a potentially active terminal's session. Claude history remains readable; native Claude continuation is a separate terminal integration, not an automatic Claude-to-Pi conversion.

Trade-off: this protects existing setups but initially gives imported sessions fewer editing/continuation powers than sessions started by Chattering.

### Nothing installed

1. Open the bundled application; show **Start a conversation** and **Find existing conversations**, not an empty timeline with no explanation.
2. Choose/create a working folder without requiring Git or a repository.
3. Connect a supported provider or enter an API key. Clearly separate using a cloud model from installing a local model; no GPU is required for cloud providers.
4. Explain and obtain approval before installing any optional command tools. Reading/searching history must not require Git Bash.
5. Send a message, run a harmless local tool action, stop a response, close/reopen the window, and find the same saved conversation.

The blank-machine sign-in experience needs implementation. `readyProviders()` and a model picker are not an onboarding flow. Explore Pi's supported authentication APIs before choosing an in-app integration; a terminal `/login` flow is acceptable for an engineering prototype, not the finished one-download experience.

## Concrete portability work

| Area | Evidence in current source | Required work |
|---|---|---|
| Runtime discovery and launch | `pisdk-runtime.js:piPackageDir()` uses `which`, nvm and Unix binaries. `pirpc.js` and `server.js:listPiModels()` directly execute `pi`. | Resolve one explicit runtime used by SDK loading, model listing, one-shot calls, RPC and delegated runs. For bundled Pi, invoke its entry point using the bundled Node executable, avoiding npm `.cmd` shims and shell-string quoting. Existing-runtime integration must validate compatibility. |
| Environment | `agentpath.js` splits/joins PATH with `:` and adds Linux paths; `server.js:agentEnv()` adds X11 settings. | Use platform delimiters, Windows environment-key rules (`Path`/`PATH`), and capability-specific additions. Keep NixOS behavior intact. |
| Session-folder names | `server.js:piSessionDirFor()` and `sandbox.js:piSessionDirName()` replace slashes but leave `:`. Pi's installed `dist/core/session-manager.js` also replaces colons. | Use Pi's public session-management behavior where possible. Do not create `--C:-Users-…--` folders on Windows. Audit the analogous Claude destination-name construction independently. |
| Paths, keys and access checks | `recentFilesTouch()` accepts only leading `/`; `projectOfPath()` and several folder operations compare `root + '/'`; `filesmode.js` resolves links with POSIX assumptions. Scan keys currently inherit `path.relative()` separators. | Separate native filesystem paths from URL/record keys. Test drive roots, mixed slashes, Unicode, spaces, case behavior, UNC paths and junction containment. Do not blindly lowercase every path or replace every slash. Audit authorization boundaries, not just display. |
| Process ownership | `server.js:scanAgentProcs()` and terminal matching read `/proc`; `delegation-store.js` reads Linux boot/start identity; supervisor cancellation uses negative process IDs. | Explicit ownership registry for managed sessions, reliable Windows process identity/cleanup, and an external-session policy. Empty `/proc` results must not be interpreted as proof that a session is free. |
| Terminal bridge | `chattering-bridge.py` imports `pty`, `fcntl`, `termios`; server launches Alacritty and uses X11 tools. | Separate native terminal launch from terminal screen/key control. Defer the latter initially; a full port needs Windows pseudoconsole integration, not just another executable name. |
| File opening | `server.js:openOnWindows()` is a WSL path-conversion helper; non-WSL uses `xdg-open`/DBus. | Native Explorer reveal and default-app open with safe argument handling. |
| Optional tools | `du` has a NixOS absolute path; audio uses `pw-play`/`pw-record`; notebook execution needs rat; LAN TLS invokes OpenSSL. | Portable implementation or explicit unavailable capability. None may block local history/search/chat startup. |
| Guest execution | `sandbox.js` depends on bubblewrap and systemd resource limits; `guestSandboxFor()` refuses without bubblewrap. Some guest UI text still describes an unwalled fallback. | Keep guest execution unavailable on native Windows until equivalent protections exist; align UI with enforcement. A Windows Job Object can manage processes/resources but is not a filesystem security sandbox. |
| Storage and privacy | Chattering paths are scattered across `.cache`, `.config`, `.local/share`, and `notes`; protected files use POSIX modes. | Centralize Chattering-owned locations. Choose Windows app-data locations for a new install; preserve existing agent folders. Test Windows ACLs, file locks, atomic replacement and SQLite behavior. POSIX `0600` is not a Windows ACL guarantee. |
| Defaults and consent | `settings.js` chooses a specific model, `doneSound: 'voice'`, a private semantic URL; speech URLs in `server.js` point at the family server; `fullScan()` schedules automatic model-generated titles. | No personal endpoints or automatic history-to-model requests on a fresh install. Explicit, visible opt-in for paid/network background work. Preserve existing users' chosen settings through a reviewed migration. |

## Recommended packaging direction

### Native backend, existing browser UI, managed runtime

Start by proving the native runtime in a portable engineering build. Then wrap the proven layout in a signed per-user Windows installer and small launcher.

Proposed release contents:

- Chattering code and versioned browser assets;
- a pinned Windows Node runtime with the SQLite features we actually use;
- a pinned, complete Pi runtime and required dependencies;
- a launcher that starts one backend, waits for authenticated application readiness, and opens the local app;
- dependency notices, version manifest, diagnostics and uninstall support.

Do not package the developer's home directory, keys, personal modes, machine instructions, or private endpoint settings. Install code separately from user data so an upgrade or uninstall cannot erase conversations.

**Why this first:** it exercises the actual native backend and preserves the same interface used on phones and other browsers. It avoids coupling a Windows port to a simultaneous UI-shell migration.

**Trade-off:** relying on Edge/Chrome app mode gives less control over browser profiles, window identity, tray behavior and close events. An Electron shell offers consistent desktop behavior but adds a bundled browser and its patching/release burden. WebView2 is another candidate, with its own runtime and bridge integration. Keep those options open until the native prototype establishes requirements; none fixes Linux assumptions in the backend.

**Managed Pi trade-off:** a private, pinned Pi code runtime makes a blank install reproducible and avoids upgrading a user's global Pi unexpectedly, but increases download size and makes Chattering responsible for runtime security updates. Shared sessions/auth/config need a separately defined compatibility contract, especially when their terminal Pi is a different version.

**Command environment decision:** prefer the documented Git Bash path for an initial full coding-tool prototype. Detect an existing installation; evaluate a licensed, versioned distribution or an explicit prerequisite installation for clean PCs. PowerShell-only agent tools are worth testing but are not equivalent to Bash-based project commands/extensions. Do not silently install Git or claim either choice is already bundled.

### Lifecycle contract

- Runs as the signed-in user, not Administrator or SYSTEM.
- Loopback-only initially; no firewall changes or public access on installation.
- Second launch focuses/reuses the existing instance. A port answering `/health` alone does not prove it is the right installation.
- Closing the browser window does not silently kill active work; the launcher offers status and explicit Quit. Explain this behavior.
- Quit/update use an authenticated graceful-shutdown channel. Windows forced termination is not equivalent to Unix SIGTERM handling.
- Managed child processes are cleaned up; delegated work is unavailable until its lifetime/cancellation contract is proven.
- Autostart is opt-in. Updates are signed, defer while work is active, and retain a recoverable previous version with compatible data migrations/backups.
- Uninstall removes program files by default, not source histories, notes, keys or user projects. Data deletion is a separate explicit action.
- Local HTTP still needs authentication, request-origin/host protections and secure bootstrap handling. A desktop launcher is not a replacement for those checks.

## First milestone and explicit exclusions

Proposed initial support target: Windows 11 x64; this is a test target, not a support claim yet. Assess ARM64 separately instead of assuming native dependencies are interchangeable.

First complete local slice:

- detect chosen Claude/Pi history, index, search, read and export;
- start a Pi conversation in a selected folder;
- model sign-in, local tools, streaming, cancel, save and reopen;
- basic file browsing/editing and Explorer integration;
- diagnostics that say what is installed, enabled and missing.

Initially defer terminal remote-control, native Claude terminal continuation, durable delegation, guest execution, notebook runtimes, configured speech services, and LAN/public hosting. Keep importable history readable even when an associated tool is unavailable. These are product scope proposals, not permission to remove existing Linux features.

## Implementation sequence

1. **Build a native proof, not an installer first.** Add Windows CI with synthetic homes/history fixtures and a pinned Node. Establish startup/index/search on an actual Windows runner with no Pi or Git on PATH, with model/network work disabled. Do not point tests at anyone's real home.
2. **Create the platform boundary.** Central runtime resolution, data locations, native path/record-key conversion, executable invocation, desktop open/reveal and capability reporting. Fix source-root discovery and session-folder encoding. Add regressions that run on Linux and Windows.
3. **Prove agent execution.** Managed Pi/Node, clean-agent config, provider setup, tool environment, streaming/cancel/reopen, and safe isolation from existing terminal sessions. Test command quoting using adversarial folder names.
4. **Build the two onboarding journeys.** History selection and privacy controls first; provider/project setup when needed. Missing credentials/tools show a helpful state, not a broken button.
5. **Package and exercise lifecycle.** Per-user install, shortcuts, repeated launch, sleep/wake, crash recovery, graceful update, rollback and data-preserving uninstall. Review licenses/notices and signing before distribution.

## Release evidence required

Use a disposable native Windows VM or runner, then a real desktop. Linux tests or mocked `process.platform` are not Windows validation.

Test at least:

- clean account with no Node, Pi, Claude, Git, WSL, or model credentials;
- Claude history only; Pi history only; both, including a running external Pi session;
- non-default source folders and a source root first created after Chattering starts;
- missing original project directories and history copied from Linux/WSL;
- usernames/projects containing spaces, accented characters, `&`, parentheses; different drives, CRLF, long paths and filesystem junctions;
- offline reading/search; zero unapproved model calls or private-server contact during import;
- package-installed vs globally installed Pi version mismatch and untrusted extensions;
- file saves while an antivirus/scanner holds a file, SQLite reopen, sleep/wake, backend crash, cancellation with child processes;
- repeated launcher clicks, port conflict, closing/reopening the window, update during an active turn, reinstall/uninstall preserving data;
- Linux regressions for every shared portability change.

No application code, installation, live service, or real conversation was changed during this investigation. No native Windows test has been performed yet.
