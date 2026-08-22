#!/usr/bin/env bash
# Open aiconvo in a dedicated Chromium app window.
# Own profile dir => own process => WM_CLASS aiconvo => native icon in dock/menu.
set -u
URL="http://localhost:${AICONVO_PORT:-7433}"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user is-active --quiet aiconvo || systemctl --user start aiconvo || true
fi

# Focus the existing app window by its unique WM_CLASS.
if command -v xdotool >/dev/null 2>&1; then
  wid=$(xdotool search --onlyvisible --class '^aiconvo$' 2>/dev/null | tail -n1)
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

# Snap Chromium is confined: it cannot use hidden dirs (~/.config/...).
# A visible path under its snap data dir works.
PROFILE="$HOME/snap/chromium/common/aiconvo-profile"
exec "$BROWSER" \
  --user-data-dir="$PROFILE" \
  --class=aiconvo \
  --no-first-run \
  --no-default-browser-check \
  --app="$URL"
