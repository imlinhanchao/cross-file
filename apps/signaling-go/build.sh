#!/usr/bin/env bash
# Build the CrossFile Go signaling binary (WebSocket v2 + static web app + TURN).
#
#   apps/signaling-go/build.sh            # build the web app, embed it, build the binary
#   SKIP_WEB=1 apps/signaling-go/build.sh # reuse/omit webdist (CI, e2e)
#
# Output: apps/signaling-go/bin/crossfile-signaling
# Go caches default to <repo>/.cache so the build works with a read-only $HOME.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

if [ "${SKIP_WEB:-0}" != "1" ]; then
  pnpm --filter @crossfile/web build
  rm -rf apps/signaling-go/webdist
  mkdir -p apps/signaling-go/webdist
  cp -R apps/web/dist/. apps/signaling-go/webdist/
fi

# //go:embed all:webdist always needs the directory to exist, even on a clean
# checkout where the web app was not built (SKIP_WEB=1).
mkdir -p apps/signaling-go/webdist
touch apps/signaling-go/webdist/.gitkeep

export GOPATH="${GOPATH:-$ROOT/.cache/go}"
export GOMODCACHE="${GOMODCACHE:-$ROOT/.cache/go/pkg/mod}"
export GOCACHE="${GOCACHE:-$ROOT/.cache/go-build}"

cd "$SCRIPT_DIR"
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/crossfile-signaling .

echo "[build] binary: apps/signaling-go/bin/crossfile-signaling"
ls -lh bin/crossfile-signaling | awk '{print "[build] size: " $5}'
