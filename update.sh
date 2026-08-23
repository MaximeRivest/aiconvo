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

# Keep the modes extension in step with the repo copy (install when missing).
PI_EXT_DIR="$HOME/.pi/agent/extensions"
if [ -f extensions/modes.ts ]; then
  mkdir -p "$PI_EXT_DIR"
  if [ ! -f "$PI_EXT_DIR/modes.ts" ]; then
    cp extensions/modes.ts "$PI_EXT_DIR/modes.ts"
    echo "installed pi extension: modes.ts → $PI_EXT_DIR"
  elif ! cmp -s extensions/modes.ts "$PI_EXT_DIR/modes.ts"; then
    echo "note: $PI_EXT_DIR/modes.ts differs from the repo copy — not overwritten."
  fi
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
