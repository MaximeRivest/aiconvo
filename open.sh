#!/usr/bin/env bash
# Open aiconvo in a Chromium app window. Reuses the running Chromium.
set -u
URL="http://localhost:${AICONVO_PORT:-7433}"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user is-active --quiet aiconvo || systemctl --user start aiconvo || true
fi

# Focus the existing app window. Regular Chromium tabs use a longer title.
if command -v xdotool >/dev/null 2>&1; then
  wid=$(xdotool search --onlyvisible --name '^aiconvo$' 2>/dev/null | tail -n1)
  if [ -n "${wid:-}" ]; then
    xdotool windowactivate "$wid"
    exit 0
  fi
fi

if command -v chromium >/dev/null 2>&1; then
  BROWSER=chromium
elif [ -x /snap/bin/chromium ]; then
  BROWSER=/snap/bin/chromium
else
  echo "chromium is not installed" >&2
  exit 1
fi

exec "$BROWSER" --app="$URL"
