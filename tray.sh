#!/usr/bin/env bash
# aiconvo tray icon (top-right panel). Left click opens the app.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:7433"

exec yad --notification \
  --image="$DIR/icon.svg" \
  --text="aiconvo — conversation browser" \
  --command="$DIR/open.sh" \
  --menu="Open aiconvo!$DIR/open.sh|Rescan now!bash -c 'curl -s -X POST $URL/api/rescan >/dev/null'|Restart server!bash -c 'systemctl --user restart aiconvo'|Quit tray!quit"
