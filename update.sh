#!/usr/bin/env bash
# Update this aiconvo checkout and restart the service.
# Run it from the repo: ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
PORT="${AICONVO_PORT:-7433}"

before="$(git rev-parse --short HEAD)"
git pull --ff-only
after="$(git rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
  echo "already up to date ($after)"
else
  echo "updated: $before → $after"
  git log --oneline "$before..$after" | sed 's/^/  /'
fi

systemctl --user restart aiconvo

ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "the server did not come back on port $PORT. See: journalctl --user -u aiconvo -n 50" >&2
  exit 1
fi
echo "aiconvo is running → http://localhost:$PORT ($after)"
