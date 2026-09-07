#!/usr/bin/env bash
set -euo pipefail
# Explicit distribution and user avoid the Windows default distribution setting.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
: "${WSL_DISTRO_NAME:?Run this installer inside WSL}"
PORT=${PORT:-7433}
PS=$(command -v powershell.exe || true)
if [[ -z "$PS" ]]; then
  PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
fi
"$PS" -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$ROOT/install.ps1")" -Distro "$WSL_DISTRO_NAME" -LinuxUser "$(id -un)" -Port "$PORT"
