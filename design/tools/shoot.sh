#!/usr/bin/env bash
# Renders the mockup screens to PNG with headless Chrome.
# Usage: bash design/tools/shoot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/screenshots"
CHROME="${CHROME:-/usr/bin/google-chrome}"
PROFILE="$(mktemp -d /tmp/crossfile-shoot-XXXXXX)"
trap 'rm -rf "$PROFILE"' EXIT
mkdir -p "$OUT"

shoot() {
  local file="$1" w="$2" h="$3" scale="$4" out="$5"
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --user-data-dir="$PROFILE" --disable-dev-shm-usage \
    --force-device-scale-factor="$scale" \
    --window-size="$w,$h" \
    --virtual-time-budget=4000 \
    --screenshot="$OUT/$out.png" \
    "file://$ROOT/screens/$file" >/dev/null 2>&1 || true
  if [ -f "$OUT/$out.png" ]; then
    printf '%-28s %s\n' "$out.png" "$(du -h "$OUT/$out.png" | cut -f1)"
  else
    echo "FAILED: $out" >&2
  fi
}

shoot 01-sender-room.html    1440 900 1 01-sender-room
shoot 02-sender-transfer.html 1440 900 1 02-sender-transfer
shoot 03-mobile-receive.html  390 844 2 03-mobile-receive
shoot 04-mobile-done.html     390 844 2 04-mobile-done
shoot 05-mobile-code.html     390 844 2 05-mobile-code
