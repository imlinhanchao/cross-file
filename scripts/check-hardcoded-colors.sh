#!/usr/bin/env bash
# Gate: no raw colors outside the token file (docs/04 §16).
# Fails the build if components hardcode #hex / rgb() / hsl() / bare oklch().
# The shell-native settings pages (Electron/Tauri) are standalone HTML/CSS outside the web
# design system and cannot import design tokens, so they are excluded from this gate.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
matches="$(
  grep -rnE "#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(|oklch\(" \
    apps packages --include='*.css' --include='*.tsx' --include='*.ts' 2>/dev/null \
    | grep -v 'tokens.css' \
    | grep -v '/dist/' | grep -v '/webdist/' | grep -v '/build/' | grep -v '/target/' | grep -v '/node_modules/' \
    | grep -v 'apps/desktop-electron/settings' | grep -v 'src-tauri/settings/' \
    | grep -v '\.test\.' \
    || true
)"

if [ -n "$matches" ]; then
  echo "FATAL: hard-coded colors outside tokens.css:" >&2
  echo "$matches" >&2
  fail=1
else
  echo "gate:colors PASS (no hard-coded colors outside tokens.css)"
fi
exit "$fail"
