#!/usr/bin/env bash
# Install aiconvo as a systemd user service on this machine.
# Works on Ubuntu and on WSL2 (with systemd enabled).
# Run it from the repo checkout: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"
PORT="${AICONVO_PORT:-7433}"

# --- 1. systemd user manager -------------------------------------------------
if ! systemctl --user show-environment >/dev/null 2>&1; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "systemd is not active in this WSL distro." >&2
    echo "Fix: add these lines to /etc/wsl.conf (sudo):" >&2
    echo "  [boot]" >&2
    echo "  systemd=true" >&2
    echo "Then run 'wsl --shutdown' in Windows, start WSL again, and re-run ./setup.sh" >&2
  else
    echo "The systemd user manager is not available. Log in as a normal user session." >&2
  fi
  exit 1
fi

# --- 2. Node 22+ -------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
NODE_MAJOR="$("${NODE_BIN:-false}" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node 22 or newer is required (found: ${NODE_BIN:-none})." >&2
  echo "Install with nvm:" >&2
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" >&2
  echo "  source ~/.nvm/nvm.sh && nvm install 22" >&2
  echo "Then re-run ./setup.sh" >&2
  exit 1
fi

# --- 3. optional tools -------------------------------------------------------
command -v pi >/dev/null 2>&1 \
  || echo "note: 'pi' is not installed — headless sends, notes, and memory builds stay off until it is."
command -v git >/dev/null 2>&1 \
  || echo "note: 'git' is not installed — repo views stay empty."

# --- 4. systemd user unit ----------------------------------------------------
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
# The service PATH must reach node's bin dir (nvm installs pi there too).
NODE_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
# On WSL, agent terminals (alacritty) need the WSLg display sockets.
DISPLAY_LINES=""
if grep -qi microsoft /proc/version 2>/dev/null; then
  DISPLAY_LINES=$'Environment=DISPLAY=:0\nEnvironment=WAYLAND_DISPLAY=wayland-0'
fi
cat > "$UNIT_DIR/aiconvo.service" <<EOF
[Unit]
Description=aiconvo conversation browser

[Service]
ExecStart=$NODE_BIN $REPO/server.js
Environment=PORT=$PORT
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
$DISPLAY_LINES
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now aiconvo
# Keep the user manager (and this service) alive without an open shell.
loginctl enable-linger "$USER" 2>/dev/null || true

# --- 5. health check ---------------------------------------------------------
ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "The server did not answer on port $PORT. See: journalctl --user -u aiconvo -n 50" >&2
  exit 1
fi

echo
echo "aiconvo is running → http://localhost:$PORT"
echo
echo "Next steps:"
echo "  1. Open http://localhost:$PORT in Chrome or Edge."
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "     (Open it in your WINDOWS browser — WSL2 forwards localhost.)"
fi
echo "  2. Install it as an app: browser menu → 'Install aiconvo' (or 'Install app')."
echo "     This gives an own window, own icon, and a launcher entry."
echo "  3. Optional: settings → semantic search. Enable it, set the server URL,"
echo "     and keep the namespace (default: your username). One namespace per user."
