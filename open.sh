#!/usr/bin/env bash
# Open Chattering in a dedicated Chromium app window.
# Own profile dir => own process => WM_CLASS Chattering => native icon in dock/menu.
set -u
URL="http://localhost:${CHATTERING_PORT:-7433}"
# The browser signs in with the install token once (a cookie keeps it):
# being on this machine is no longer a credential by itself.
TOKEN_FILE="${CHATTERING_CACHE_DIR:-$HOME/.cache/chattering}/lan-token"
if [ -r "$TOKEN_FILE" ]; then URL="$URL/?token=$(tr -d '\n' < "$TOKEN_FILE")"; fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user is-active --quiet chattering || systemctl --user start chattering || true
fi

# Focus the existing app window by its unique WM_CLASS.
if command -v xdotool >/dev/null 2>&1; then
  wid=$(xdotool search --onlyvisible --class '^chattering$' 2>/dev/null | tail -n1)
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
PROFILE="$HOME/snap/chromium/common/chattering-profile"
exec "$BROWSER" \
  --user-data-dir="$PROFILE" \
  --class=chattering \
  --no-first-run \
  --no-default-browser-check \
  --app="$URL"
