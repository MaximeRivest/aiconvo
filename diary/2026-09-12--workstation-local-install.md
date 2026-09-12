# Workstation-local AIconvo installation

Operator chose a local `softwareco/contrib/aiconvo` clone instead of the proposed
NAS deployment. Origin/master baseline: `aa023073bb8eee985ebfd404ee4d431cb83ccf6c`.

Installed a loopback user service and application launcher without running upstream
setup.sh, modifying global Pi extensions, changing file associations, or touching
the NAS. Added opt-in background-model suppression and source-root overrides.
The 13 GiB Pi archive motivated an initial three-session COMPASS-C scope (14 MiB).

Verification: 41 focused tests, upstream Chromium app fixture, and a read-only
live-service probe of the actual report passed. Restart retained the three-session
index. Full upstream test-suite execution, manual model sends, and cell execution
remain unverified. Full details and rollback: `deploy/workstation/README.md`.

Lesson: editor reuse does not imply CRDT networking or filesystem replication.
AIconvo's MRMD bundle explicitly excludes those networking components. Also,
installing a conversation viewer can initiate automatic inference; inspect startup
schedulers and source scope before exposing a large private history archive.
