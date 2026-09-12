# Workstation-local AIconvo installation

Operator chose a local `softwareco/contrib/aiconvo` clone instead of the proposed
NAS deployment. Origin/master baseline: `aa023073bb8eee985ebfd404ee4d431cb83ccf6c`.

Installed a loopback user service and application launcher without running upstream
setup.sh, modifying global Pi extensions, changing file associations, or touching
the NAS. Added opt-in background-model suppression and source-root overrides.
The 13 GiB Pi archive motivated an initial three-session COMPASS-C scope (14 MiB).

Verification: 41 focused tests, upstream Chromium app fixture, and a read-only
live-service probe of the actual report passed. Restart retained the three-session
index. At initial installation, the full upstream suite had not run. On operator
follow-up it completed in an isolated sandbox: 468 passed, 1 failed, 1 skipped;
all four browser integration tests passed. The remaining failure is custom-TMPDIR
classification in project creation, not a passing full gate. Manual model sends
and cell execution remain unverified. Full details and rollback:
`deploy/workstation/README.md`.

Separately, operator confirmed a native Niri activation probe brought Brave
forward. The persistent host-only override is
`~/.local/share/applications/brave-browser.desktop`, with main Exec changed to
`/usr/bin/niri msg action spawn -- /usr/bin/brave %U`. An invalid MIME declaration
in the copied upstream private-window action was removed from the override;
the original system desktop file was untouched. Desktop validation and an actual
xdg-open probe passed: focus moved from Ghostty to Brave. Browser identity and
HTTP/HTTPS default associations stayed unchanged. No custom focus script or
Niri configuration change was needed. This host observation is not an AIconvo
runtime code change.

Lesson: editor reuse does not imply CRDT networking or filesystem replication.
AIconvo's MRMD bundle explicitly excludes those networking components. Also,
installing a conversation viewer can initiate automatic inference; inspect startup
schedulers and source scope before exposing a large private history archive.
